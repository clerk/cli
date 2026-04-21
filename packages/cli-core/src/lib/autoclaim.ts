import { basename, join } from "node:path";
import { readKeylessBreadcrumb, clearKeylessBreadcrumb } from "./keyless.ts";
import { claimApplication, type Application } from "./plapi.ts";
import { PlapiError, errorMessage } from "./errors.ts";
import { linkApp } from "./autolink.ts";
import { pull } from "../commands/env/pull.ts";
import { log } from "./log.ts";

type Claimed = { status: "claimed"; app: Application; envPulled: boolean };
type Terminal = { status: "not_found" | "no_organization" };
type Failed = { status: "failed"; error: Error };
type Skipped = { status: "not_keyless" };

export type AutoclaimResult = Claimed | Terminal | Failed | Skipped;

type ClaimAttempt = { status: "claimed"; app: Application } | Terminal | Failed;

const APP_NAME_MAX_CHARS = 50;

const TERMINAL_BY_STATUS: Record<number, Terminal["status"]> = {
  404: "not_found",
  403: "no_organization",
};

async function deriveAppName(cwd: string): Promise<string> {
  try {
    const pkg: { name?: unknown } = await Bun.file(join(cwd, "package.json")).json();
    if (typeof pkg.name === "string" && pkg.name.trim()) return pkg.name.trim();
  } catch {
    // fall through
  }
  return basename(cwd);
}

function truncateToChars(str: string, max: number): string {
  const segments = [...new Intl.Segmenter().segment(str)];
  return segments.length <= max
    ? str
    : segments
        .slice(0, max)
        .map((s) => s.segment)
        .join("");
}

/** Orchestrates post-login claim of a keyless app. Never throws. */
export async function attemptAutoclaim(cwd: string): Promise<AutoclaimResult> {
  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (!breadcrumb) return { status: "not_keyless" };

  const rawName = await deriveAppName(cwd);
  const appName = truncateToChars(rawName, APP_NAME_MAX_CHARS);
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
