import { readKeylessBreadcrumb, clearKeylessBreadcrumb } from "./keyless.ts";
import {
  claimApplication,
  fetchApplication,
  type Application,
  type ApplicationInstance,
} from "./plapi.ts";
import { PlapiError, errorMessage } from "./errors.ts";
import { linkApp } from "./autolink.ts";
import { resolveProfile } from "./config.ts";
import { decodePublishableKey } from "./fapi.ts";
import { readFolderKeys, type FolderKeys } from "./local-keys.ts";
import { deriveProjectName } from "./project-name.ts";
import { pull } from "../commands/env/pull.ts";
import { log } from "./log.ts";

/**
 * Why a successful claim left the folder's link and env files as they were.
 * - `linked_elsewhere`: the folder is already linked to a different app.
 * - `different_keys`: a key the folder holds belongs to a different app.
 * - `unverified`: the CLI couldn't tell whether the folder's keys belong to the
 *   claimed app, so it didn't risk overwriting them.
 */
export type FolderUnchanged =
  | {
      kind: "unchanged";
      reason: "linked_elsewhere";
      linkedTo: { appId: string; appName?: string };
    }
  | {
      kind: "unchanged";
      reason: "different_keys";
      key: "publishable" | "secret";
      /** Where the mismatched key came from, for display. Never the key itself. */
      source: string;
    }
  | { kind: "unchanged"; reason: "unverified" };

/**
 * What a successful claim did to the folder it ran in.
 * - `linked`: the folder now uses the claimed app; `envPulled` says whether its keys were written too.
 * - `link_failed`: the folder should have been linked, but writing the link failed.
 */
export type FolderSetup =
  | { kind: "linked"; envPulled: boolean }
  | { kind: "link_failed" }
  | FolderUnchanged;

type Claimed = { status: "claimed"; app: Application; local: FolderSetup };
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

export type AutoclaimResult = Claimed | Terminal | ManagedWorkspace | Failed | Skipped;

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
    return { ...result, local: await setUpFolder(result.app, cwd) };
  }

  return result;
}

async function setUpFolder(app: Application, cwd: string): Promise<FolderSetup> {
  const unchanged = await reasonToLeaveFolder(app, cwd);
  if (unchanged) return unchanged;

  if (!(await tryLinkApp(app, cwd))) return { kind: "link_failed" };
  return { kind: "linked", envPulled: await tryPullEnv() };
}

const UNVERIFIED: FolderUnchanged = { kind: "unchanged", reason: "unverified" };

/**
 * Decides whether linking the claimed app and pulling its keys would set this
 * folder up, or point it at an app it doesn't run on. Returns why to leave the
 * folder alone, or `undefined` to go ahead.
 *
 * Runs after the claim, not before: the init token file holds only the token,
 * with no app identity, so nothing names the app until the claim response
 * does. Checking afterwards needs no change to the token file and protects
 * every token already on disk. A mismatched app still lands in the account,
 * which is harmless: it's the person's app.
 *
 * Every check answers yes, no, or couldn't tell, and "couldn't tell" never
 * relinks the folder or overwrites its keys.
 */
async function reasonToLeaveFolder(
  claimed: Application,
  cwd: string,
): Promise<FolderUnchanged | undefined> {
  let linked: Awaited<ReturnType<typeof resolveProfile>>;
  try {
    linked = await resolveProfile(cwd);
  } catch (error) {
    log.debug(`autoclaim: couldn't read this folder's link — ${errorMessage(error)}`);
    return UNVERIFIED;
  }
  if (linked && linked.profile.appId !== claimed.application_id) {
    log.debug(`autoclaim: folder is linked to ${linked.profile.appId}; leaving it alone`);
    return {
      kind: "unchanged",
      reason: "linked_elsewhere",
      linkedTo: { appId: linked.profile.appId, appName: linked.profile.appName },
    };
  }

  let folderKeys: FolderKeys;
  try {
    folderKeys = await readFolderKeys(cwd);
  } catch (error) {
    log.debug(`autoclaim: couldn't read this folder's keys — ${errorMessage(error)}`);
    return UNVERIFIED;
  }
  // A folder with no keys is what a claim should set up.
  if (!folderKeys.publishableKey && !folderKeys.secretKey) {
    log.debug("autoclaim: folder holds no Clerk keys; setting it up for the claimed app");
    return undefined;
  }

  let checks = checkFolderKeys(folderKeys, claimed.instances);
  if (!checks.some(isMismatch) && checks.some(isUnknown)) {
    // The claim response normally carries every instance's keys. When it
    // doesn't, one fetch of the app can settle what the response couldn't.
    log.debug(`autoclaim: claim response can't settle the folder's keys; fetching the app once`);
    try {
      checks = checkFolderKeys(
        folderKeys,
        (await fetchApplication(claimed.application_id)).instances,
      );
    } catch (error) {
      log.debug(`autoclaim: fetching the claimed app failed — ${errorMessage(error)}`);
      return UNVERIFIED;
    }
  }

  // A key known to belong to another app settles it, even if another key
  // couldn't be compared.
  const mismatch = checks.find(isMismatch);
  if (mismatch) {
    log.debug(`autoclaim: ${mismatch.key} key from ${mismatch.source} belongs to another app`);
    return {
      kind: "unchanged",
      reason: "different_keys",
      key: mismatch.key,
      source: mismatch.source,
    };
  }
  const unknown = checks.find(isUnknown);
  if (unknown) {
    log.debug(`autoclaim: couldn't compare the ${unknown.key} key from ${unknown.source}`);
    return UNVERIFIED;
  }
  log.debug(`autoclaim: folder's keys belong to ${claimed.application_id}; setting it up`);
  return undefined;
}

type KeyComparison = "match" | "mismatch" | "unknown";

interface KeyCheck {
  key: "publishable" | "secret";
  source: string;
  result: KeyComparison;
}

const isMismatch = (check: KeyCheck) => check.result === "mismatch";
const isUnknown = (check: KeyCheck) => check.result === "unknown";

/** Compares every key the folder holds with the claimed app's instances. */
function checkFolderKeys(
  folderKeys: FolderKeys,
  instances: readonly ApplicationInstance[] | undefined,
): KeyCheck[] {
  // Deserialized API JSON: a missing array means there is nothing to compare
  // against, not a crash.
  const list = Array.isArray(instances) ? instances : [];
  const checks: KeyCheck[] = [];
  if (folderKeys.publishableKey) {
    checks.push({
      key: "publishable",
      source: folderKeys.publishableKey.source,
      result: comparePublishableKey(folderKeys.publishableKey.value, list),
    });
  }
  if (folderKeys.secretKey) {
    checks.push({
      key: "secret",
      source: folderKeys.secretKey.source,
      result: compareSecretKey(folderKeys.secretKey.value, list),
    });
  }
  return checks;
}

/**
 * A publishable key belongs to the claimed app when it is one of the app's
 * keys, or decodes to the same Frontend API host as one of them: the host is
 * the app instance's identity, the rule `hasKeyPairMismatch` in
 * `keyless-target.ts` already relies on. An identical key needs no decoding,
 * so a key that can't be decoded but is the app's own still matches.
 */
function comparePublishableKey(
  local: string,
  instances: readonly ApplicationInstance[],
): KeyComparison {
  const localHost = frontendApiHost(local);
  let couldNotCompare = instances.length === 0;
  for (const instance of instances) {
    const theirs = instance.publishable_key;
    if (typeof theirs !== "string" || !theirs) {
      couldNotCompare = true;
      continue;
    }
    if (theirs === local) return "match";
    const theirHost = frontendApiHost(theirs);
    if (localHost === undefined || theirHost === undefined) {
      couldNotCompare = true;
      continue;
    }
    if (theirHost === localHost) return "match";
  }
  return couldNotCompare ? "unknown" : "mismatch";
}

/**
 * A secret key belongs to the claimed app only when it is one of the app's
 * secret keys. Compared in memory only: neither value may reach a log line, an
 * error message, a result, or telemetry. A plain comparison is fine, since both
 * values are already in this process and nothing outside it observes the timing.
 */
function compareSecretKey(local: string, instances: readonly ApplicationInstance[]): KeyComparison {
  let couldNotCompare = instances.length === 0;
  for (const instance of instances) {
    const theirs = instance.secret_key;
    if (typeof theirs !== "string" || !theirs) {
      couldNotCompare = true;
      continue;
    }
    if (theirs === local) return "match";
  }
  return couldNotCompare ? "unknown" : "mismatch";
}

function frontendApiHost(publishableKey: string): string | undefined {
  try {
    return decodePublishableKey(publishableKey).fapiHost;
  } catch {
    return undefined;
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
    if (await linkApp(app, cwd)) return true;
    throw new Error("the application has no development instance");
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
