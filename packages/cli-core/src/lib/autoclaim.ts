import { readKeylessBreadcrumb, clearKeylessBreadcrumb } from "./keyless.ts";
import { claimApplication, type Application } from "./plapi.ts";
import { PlapiError, errorMessage } from "./errors.ts";
import { findClerkKeys, linkApp } from "./autolink.ts";
import { deriveProjectName } from "./project-name.ts";
import { pull } from "../commands/env/pull.ts";
import { log } from "./log.ts";

type Claimed = { status: "claimed"; app: Application; envPulled: boolean };
/** The claim can never succeed with this token; the breadcrumb is cleared. */
type Terminal = { status: "not_found" | "no_organization" };
/**
 * The token's workspace is provisioned by an integration (Vercel Marketplace,
 * Stripe), so nothing can be claimed into it. The breadcrumb is kept: the user
 * switches to a workspace they own and the next `clerk auth login` retries.
 * `longMessage` is the API's `long_message`, which names the provider.
 */
type ManagedWorkspace = { status: "managed_workspace"; longMessage: string | null };
type Failed = { status: "failed"; error: Error };
type Skipped = { status: "not_keyless" };
/**
 * The claim succeeded, but a publishable key in the folder belongs to another application,
 * so linking and pulling would pair that key with the claimed app's secret key. Nothing was
 * linked or written. `sources` names where each mismatching key was found.
 */
export type KeysMismatch = { status: "keys_mismatch"; app: Application; sources: string[] };

export type AutoclaimResult =
  | Claimed
  | Terminal
  | ManagedWorkspace
  | Failed
  | Skipped
  | KeysMismatch;

type ClaimAttempt = { status: "claimed"; app: Application } | Terminal | ManagedWorkspace | Failed;

/** PLAPI error code for a claim into a provider-managed workspace. */
const MANAGED_WORKSPACE_CODE = "accountless_application_managed_workspace";

const TERMINAL_BY_STATUS: Record<number, Terminal["status"]> = {
  404: "not_found",
  403: "no_organization",
};

/** Orchestrates post-login claim of a keyless app. Never throws. */
export async function attemptAutoclaim(cwd: string): Promise<AutoclaimResult> {
  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (!breadcrumb) return { status: "not_keyless" };

  const appName = await deriveProjectName(cwd);
  const result = await tryClaim(breadcrumb.claimToken, appName);

  if (result.status === "failed" || result.status === "managed_workspace") return result;

  await clearKeylessBreadcrumb(cwd);

  if (result.status === "claimed") {
    const sources = await mismatchingKeySources(result.app, cwd);
    if (sources.length > 0) return { status: "keys_mismatch", app: result.app, sources };
    const linked = await tryLinkApp(result.app, cwd);
    const envPulled = linked && (await tryPullEnv());
    return { ...result, envPulled };
  }

  return result;
}

async function mismatchingKeySources(app: Application, cwd: string): Promise<string[]> {
  // Deserialized API JSON: a claim response without instances must not throw here.
  const expected = app.instances?.find(
    (instance) => instance.environment_type === "development",
  )?.publishable_key;
  if (!expected) return [];
  try {
    const keys = await findClerkKeys(cwd);
    return keys.filter((found) => found.key !== expected).map((found) => found.source);
  } catch (error) {
    log.debug(`autoclaim: could not read local publishable keys: ${errorMessage(error)}`);
    return [];
  }
}

async function tryClaim(claimToken: string, name: string): Promise<ClaimAttempt> {
  try {
    const app = await claimApplication(claimToken, name);
    return { status: "claimed", app };
  } catch (error) {
    return classifyClaimError(error);
  }
}

// Preserves the orchestrator's never-throws contract. Claim has already
// succeeded on the server and the breadcrumb is cleared — a local link
// failure must not surface as a failed login.
async function tryLinkApp(app: Application, cwd: string): Promise<boolean> {
  try {
    await linkApp(app, cwd);
    return true;
  } catch (error) {
    log.warn(
      `Claim succeeded but linking the project locally failed: ${errorMessage(error)}. Run \`clerk link\` to finish setup.`,
    );
    return false;
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

function classifyClaimError(error: unknown): Terminal | ManagedWorkspace | Failed {
  if (
    error instanceof PlapiError &&
    error.status === 403 &&
    error.code === MANAGED_WORKSPACE_CODE
  ) {
    log.debug(`Claim returned 403 ${MANAGED_WORKSPACE_CODE}: classified as managed_workspace`);
    return { status: "managed_workspace", longMessage: error.longMessage };
  }

  if (error instanceof PlapiError && error.status in TERMINAL_BY_STATUS) {
    const status = TERMINAL_BY_STATUS[error.status]!;
    log.debug(`Claim returned ${error.status}: classified as ${status}`);
    return { status };
  }

  const err = error instanceof Error ? error : new Error(String(error));
  log.debug(`Autoclaim failed: ${err.message}`);
  return { status: "failed", error: err };
}

const CLAIM_WARNINGS: Partial<Record<AutoclaimResult["status"], string>> = {
  not_found:
    "Claim token is no longer valid - the application may have been claimed from the dashboard.",
  no_organization: "Unable to claim - your account does not have an active organization.",
  failed:
    "Auto-claim failed due to a temporary error. It will be retried on your next `clerk auth login`.",
};

/** The warning `clerk auth login` and `clerk link` print for a claim that didn't link the folder. */
export function claimWarning(result: AutoclaimResult): string | undefined {
  if (result.status === "managed_workspace") {
    // The API message already names the provider and says what to do.
    return `Unable to claim - ${result.longMessage ?? "this workspace is managed by an integration provider."}`;
  }
  if (result.status === "keys_mismatch") return keysMismatchMessage(result);
  return CLAIM_WARNINGS[result.status];
}

export function keysMismatchMessage(result: KeysMismatch): string {
  const { app, sources } = result;
  const label = app.name ? `\`${app.name}\` (${app.application_id})` : `\`${app.application_id}\``;
  const holder =
    sources.length === 1
      ? `${sources[0]} holds a publishable key`
      : `${sources.slice(0, -1).join(", ")} and ${sources.at(-1)} hold publishable keys`;
  return (
    `Claimed application ${label} into your account, but ${holder} for a different application, ` +
    "so this folder wasn't linked and its keys weren't changed. " +
    "Run `clerk link --app <app_id>` with the application this folder should use."
  );
}
