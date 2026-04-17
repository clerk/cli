/**
 * Autoclaim orchestrator.
 *
 * After `clerk auth login`, detects whether the current directory is a keyless
 * project (has .clerk/keyless.json) and claims the application automatically.
 *
 * NEVER throws — all errors are returned as status values so the login flow
 * is never interrupted by autoclaim failures.
 */

import { basename } from "node:path";
import { readKeylessBreadcrumb, clearKeylessBreadcrumb } from "./keyless.ts";
import { claimApplication, type Application } from "./plapi.ts";
import { PlapiError } from "./errors.ts";
import { linkApp } from "./autolink.ts";
import { pull } from "../commands/env/pull.ts";
import { log } from "./log.ts";

type Claimed = { status: "claimed"; app: Application; envPulled: boolean };
type Terminal = { status: "not_found" | "already_claimed" };
type Failed = { status: "failed"; error: Error };
type Skipped = { status: "not_keyless" };

export type AutoclaimResult = Claimed | Terminal | Failed | Skipped;

type ClaimAttempt = { status: "claimed"; app: Application } | Terminal | Failed;

export async function attemptAutoclaim(cwd: string): Promise<AutoclaimResult> {
  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (!breadcrumb) return { status: "not_keyless" };

  const appName = basename(cwd).slice(0, 50);
  const result = await tryClaim(breadcrumb.claimToken, appName);

  // Transient failures keep the breadcrumb so the next login can retry.
  // Terminal statuses (not_found, already_claimed, claimed) clear it.
  if (result.status === "failed") return result;

  await clearKeylessBreadcrumb(cwd);

  if (result.status === "claimed") {
    await linkApp(result.app, cwd);
    const envPulled = await tryPullEnv();
    return { ...result, envPulled };
  }

  return result;
}

async function tryClaim(claimToken: string, name: string): Promise<ClaimAttempt> {
  try {
    const app = await claimApplication(claimToken, name);
    return { status: "claimed", app };
  } catch (error) {
    return classifyClaimError(error);
  }
}

async function tryPullEnv(): Promise<boolean> {
  try {
    await pull({});
    return true;
  } catch (error) {
    log.debug(`Auto env pull failed: ${error instanceof Error ? error.message : String(error)}`);
    return false;
  }
}

function classifyClaimError(error: unknown): Terminal | Failed {
  if (error instanceof PlapiError && error.status === 404) {
    log.debug("Claim token not found (app may have been claimed already or expired)");
    return { status: "not_found" };
  }

  if (error instanceof PlapiError && error.status === 403) {
    log.debug("Not authorized to claim (missing active organization)");
    return { status: "already_claimed" };
  }

  const err = error instanceof Error ? error : new Error(String(error));
  log.debug(`Autoclaim failed: ${err.message}`);
  return { status: "failed", error: err };
}
