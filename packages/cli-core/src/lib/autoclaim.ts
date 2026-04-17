import { basename } from "node:path";
import { readKeylessBreadcrumb, clearKeylessBreadcrumb } from "./keyless.ts";
import { claimApplication, type Application } from "./plapi.ts";
import { PlapiError, errorMessage } from "./errors.ts";
import { linkApp } from "./autolink.ts";
import { pull } from "../commands/env/pull.ts";
import { log } from "./log.ts";

type Claimed = { status: "claimed"; app: Application; envPulled: boolean };
type Terminal = { status: "not_found" | "already_claimed" };
type Failed = { status: "failed"; error: Error };
type Skipped = { status: "not_keyless" };

export type AutoclaimResult = Claimed | Terminal | Failed | Skipped;

type ClaimAttempt = { status: "claimed"; app: Application } | Terminal | Failed;

const APP_NAME_MAX = 50;

const TERMINAL_BY_STATUS: Record<number, Terminal["status"]> = {
  404: "not_found",
  403: "already_claimed",
};

/** Orchestrates post-login claim of a keyless app. Never throws. */
export async function attemptAutoclaim(cwd: string): Promise<AutoclaimResult> {
  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (!breadcrumb) return { status: "not_keyless" };

  const appName = basename(cwd).slice(0, APP_NAME_MAX);
  const result = await tryClaim(breadcrumb.claimToken, appName);

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
    log.debug(`Auto env pull failed: ${errorMessage(error)}`);
    return false;
  }
}

function classifyClaimError(error: unknown): Terminal | Failed {
  if (error instanceof PlapiError && error.status in TERMINAL_BY_STATUS) {
    const status = TERMINAL_BY_STATUS[error.status]!;
    log.debug(`Claim returned ${error.status}: classified as ${status}`);
    return { status };
  }

  const err = error instanceof Error ? error : new Error(String(error));
  log.debug(`Autoclaim failed: ${err.message}`);
  return { status: "failed", error: err };
}
