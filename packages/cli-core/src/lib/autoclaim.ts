import { clearKeylessBreadcrumb, readKeylessBreadcrumb } from "./keyless.ts";
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
import {
  isClerkKeyShaped,
  readAllFolderKeys,
  readFolderKeys,
  type AllFolderKeys,
  type FolderKeys,
  type LocatedKey,
} from "./local-keys.ts";
import { deriveProjectName } from "./project-name.ts";
import { pull } from "../commands/env/pull.ts";
import { log } from "./log.ts";

/**
 * Why a successful claim left the folder's link and env files as they were.
 * - `linked_elsewhere`: the folder is already linked to a different app.
 * - `different_keys`: a key the folder holds isn't the claimed app's.
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
      /**
       * The mismatched key to name: the one the app loads when it's among the
       * mismatches, otherwise a publishable key, otherwise the first.
       */
      key: "publishable" | "secret";
      /** The variable it's stored under. */
      name: string;
      /** Where that key came from, for display. Never the key itself. */
      source: string;
      /** Another key in the folder is the claimed app's, so the folder mixes two apps' keys. */
      mixed: boolean;
      /**
       * Plain `clerk link` can try to match this key by itself: the folder
       * isn't linked, its keys don't mix apps, and this is the publishable key
       * the app loads, as `readFolderKeys` (the reader `clerk link` matches
       * with) picks it. It only says `clerk link` will try: the app may be in
       * another workspace. When false, advice names `clerk link --app`.
       */
      linkCanTryKey: boolean;
    }
  | { kind: "unchanged"; reason: "unverified" };

/**
 * What a successful claim did to the folder it ran in.
 * - `linked`: the folder now uses the claimed app; `envPulled` says whether its keys were written too.
 * - `link_failed`: the folder should have been linked, but writing the link failed. `reason`
 *   says why, for display; it never contains a key.
 */
export type FolderSetup =
  | { kind: "linked"; envPulled: boolean }
  | { kind: "link_failed"; reason: string }
  | FolderUnchanged;

/** `app` is the claimed app, completed by one fetch when the claim response lacked its instances. */
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
export type AutoclaimResult = Claimed | Terminal | ManagedWorkspace | Failed;

type ClaimAttempt = { status: "claimed"; app: Application } | Terminal | ManagedWorkspace | Failed;

/** PLAPI error code for a claim into a provider-managed workspace. */
const MANAGED_WORKSPACE_CODE = "accountless_application_managed_workspace";

const TERMINAL_BY_STATUS: Record<number, Terminal["status"]> = {
  404: "not_found",
  403: "no_organization",
};

/**
 * The folder's init token, and the name the claim will give its app. The token
 * is credential-equivalent: never log it or put it in a message.
 */
export type InitClaim = { appName: string; claimToken: string };

/**
 * Reads the folder's init token once, for one claim; undefined without one.
 * Like every read of the token file, a malformed file is warned about and
 * deleted.
 */
export async function readInitClaim(cwd: string): Promise<InitClaim | undefined> {
  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (!breadcrumb) return undefined;
  return { appName: await deriveProjectName(cwd), claimToken: breadcrumb.claimToken };
}

/**
 * Claims the app behind `init`, read by `readInitClaim`, then sets up the
 * folder if its keys allow. Never throws.
 *
 * Takes the token rather than reading the file, so a caller claims exactly the
 * token it read (and asked a person about), never one that appeared or
 * replaced it since. The file is deleted only while it still holds that token.
 */
export async function attemptAutoclaim(cwd: string, init: InitClaim): Promise<AutoclaimResult> {
  const result = await tryClaim(init.claimToken, init.appName);

  if (result.status === "failed" || result.status === "managed_workspace") return result;

  await clearKeylessBreadcrumb(cwd, init.claimToken);

  if (result.status === "claimed") {
    return { status: "claimed", ...(await setUpFolder(result.app, cwd)) };
  }

  return result;
}

async function setUpFolder(
  claimed: Application,
  cwd: string,
): Promise<{ app: Application; local: FolderSetup }> {
  const { app, leave } = await checkFolder(claimed, cwd);
  if (leave) return { app, local: leave };

  if (!hasInstances(app)) {
    return {
      app,
      local: {
        kind: "link_failed",
        reason: "the claim response listed no environments and fetching the application failed",
      },
    };
  }
  const linkError = await tryLinkApp(app, cwd);
  if (linkError) return { app, local: { kind: "link_failed", reason: linkError } };
  return { app, local: { kind: "linked", envPulled: await tryPullEnv(cwd) } };
}

const UNVERIFIED: FolderUnchanged = { kind: "unchanged", reason: "unverified" };

/**
 * Decides whether linking the claimed app and pulling its keys would set this
 * folder up, or point it at an app it doesn't run on. Returns why to leave the
 * folder alone, if it should be, and the claimed app as completed.
 *
 * Runs after the claim, not before: the init token file holds only the token,
 * with no app identity, so nothing names the app until the claim response
 * does. Checking afterwards needs no change to the token file and protects
 * every token already on disk. A mismatched app still lands in the account,
 * which is harmless: it's the person's app.
 *
 * Every Clerk key the folder holds is compared, not just the one the app
 * loads: which key that is depends on the framework, and `clerk env pull`
 * picks its own file to write, so any key left uncompared could be the one it
 * replaces. Every check answers yes, no, or couldn't tell, and "couldn't tell"
 * never relinks the folder or overwrites its keys.
 */
async function checkFolder(
  claimed: Application,
  cwd: string,
): Promise<{ app: Application; leave?: FolderUnchanged }> {
  // The claim response normally carries the app's instances (its development
  // and production environments) with their keys. When it can't settle what
  // the folder needs, the app is fetched once, and the fetched copy is used
  // from then on, so the link and the printed Dashboard URL use the same
  // complete app the comparison did.
  let app = claimed;
  let fetchSucceeded: boolean | undefined;
  const fetchOnce = async (): Promise<boolean> => {
    if (fetchSucceeded !== undefined) return fetchSucceeded;
    log.debug(`autoclaim: fetching ${claimed.application_id}; the claim response is incomplete`);
    try {
      app = await fetchApplication(claimed.application_id);
      fetchSucceeded = true;
    } catch (error) {
      log.debug(`autoclaim: fetching the claimed app failed — ${errorMessage(error)}`);
      fetchSucceeded = false;
    }
    return fetchSucceeded;
  };
  const leave = (reason: FolderUnchanged) => ({ app, leave: reason });

  let linked: Awaited<ReturnType<typeof resolveProfile>>;
  try {
    linked = await resolveProfile(cwd);
  } catch (error) {
    log.debug(`autoclaim: couldn't read this folder's link — ${errorMessage(error)}`);
    return leave(UNVERIFIED);
  }
  if (linked && linked.profile.appId !== claimed.application_id) {
    log.debug(`autoclaim: folder is linked to ${linked.profile.appId}; leaving it alone`);
    return leave({
      kind: "unchanged",
      reason: "linked_elsewhere",
      linkedTo: { appId: linked.profile.appId, appName: linked.profile.appName },
    });
  }

  // Linking needs the instances whatever the folder holds.
  if (!hasInstances(app)) await fetchOnce();

  const comparison = await compareFolderKeys(cwd, () => app, fetchOnce);
  if (comparison.kind === "unreadable_folder") return leave(UNVERIFIED);
  if (comparison.kind === "unusable_sdk_file") {
    // The SDK keyless file is there but names no app, so whatever the folder
    // runs on, the CLI can't tell, and can't risk replacing it.
    log.debug("autoclaim: the SDK keyless file is unreadable or holds no key");
    return leave(UNVERIFIED);
  }
  if (comparison.kind === "no_keys") {
    // A folder with no keys is what a claim should set up.
    log.debug("autoclaim: folder holds no Clerk keys; setting it up for the claimed app");
    return { app };
  }
  const { checks } = comparison;

  // A key known to belong to another app settles it, even if another key
  // couldn't be compared or read.
  const mismatches = checks.filter(isMismatch);
  if (mismatches.length > 0) {
    const effective = await effectiveKeys(cwd);
    const mismatch = mismatchToName(mismatches, effective);
    const mixed = checks.some((check) => check.result === "match");
    log.debug(`autoclaim: ${mismatch.name} from ${mismatch.source} isn't the claimed app's`);
    return leave({
      kind: "unchanged",
      reason: "different_keys",
      key: mismatch.key,
      name: mismatch.name,
      source: mismatch.source,
      mixed,
      linkCanTryKey:
        !linked &&
        !mixed &&
        mismatch.key === "publishable" &&
        effective !== undefined &&
        effective.unreadableLines === undefined &&
        isEffective(mismatch, effective),
    });
  }
  const unknown = checks.find((check) => check.result !== "match");
  if (unknown) {
    log.debug(`autoclaim: couldn't compare ${unknown.name} from ${unknown.source}`);
    return leave(UNVERIFIED);
  }
  log.debug(`autoclaim: every key in the folder is ${claimed.application_id}'s; setting it up`);
  return { app };
}

/** Whether a folder's Clerk keys all belong to one app; see `folderKeysBelongTo`. */
export type FolderKeysVerdict =
  | { verdict: "match" }
  | {
      verdict: "mismatch" | "couldnt_tell";
      /** The key it's about, when there is one; never the key's value. */
      key?: { name: string; source: string };
    };

/**
 * Whether every Clerk key the folder holds belongs to `app`, compared the way
 * the claim check compares them. For a link that writes `app`'s keys next:
 * `clerk init` after a claim attempt saves the link only on `match`, so no
 * write replaces a key another app owns. A folder with no keys matches.
 * Fetches the app once when it lacks the keys to compare.
 *
 * "Couldn't tell" covers keys that can't be read or compared, and a present
 * but unusable SDK keyless file; callers treat it like a mismatch.
 */
export async function folderKeysBelongTo(
  app: Application,
  cwd: string,
): Promise<FolderKeysVerdict> {
  let current = app;
  let fetched: boolean | undefined;
  const fetchOnce = async (): Promise<boolean> => {
    if (fetched !== undefined) return fetched;
    try {
      current = await fetchApplication(app.application_id);
      fetched = true;
    } catch (error) {
      log.debug(`autoclaim: fetching ${app.application_id} failed — ${errorMessage(error)}`);
      fetched = false;
    }
    return fetched;
  };

  const comparison = await compareFolderKeys(cwd, () => current, fetchOnce);
  if (comparison.kind === "no_keys") return { verdict: "match" };
  if (comparison.kind !== "compared") return { verdict: "couldnt_tell" };

  const { checks } = comparison;
  const mismatches = checks.filter(isMismatch);
  if (mismatches.length > 0) {
    const mismatch = mismatchToName(mismatches, await effectiveKeys(cwd));
    return { verdict: "mismatch", key: { name: mismatch.name, source: mismatch.source } };
  }
  const unknown = checks.find((check) => check.result !== "match");
  if (unknown) {
    return { verdict: "couldnt_tell", key: { name: unknown.name, source: unknown.source } };
  }
  return { verdict: "match" };
}

/**
 * How every Clerk key the folder holds compares with `app()`'s, before any
 * verdict: shared by the claim check and `folderKeysBelongTo`, so both mean
 * the same thing by "this folder's keys belong to that app". Fetches the app
 * at most once, through `fetchOnce`, and only when its data lacks a key to
 * compare; `app()` returns the fetched copy after that.
 *
 * - `unreadable_folder`: an env file couldn't be read.
 * - `unusable_sdk_file`: no plain key, and an SDK keyless file that names no app.
 * - `no_keys`: nothing to compare.
 */
type FolderComparison =
  | { kind: "unreadable_folder" }
  | { kind: "unusable_sdk_file" }
  | { kind: "no_keys" }
  | { kind: "compared"; checks: KeyCheck[] };

async function compareFolderKeys(
  cwd: string,
  app: () => Application,
  fetchOnce: () => Promise<boolean>,
): Promise<FolderComparison> {
  let folderKeys: AllFolderKeys;
  try {
    folderKeys = await readAllFolderKeys(cwd);
  } catch (error) {
    log.debug(`autoclaim: couldn't read this folder's keys — ${errorMessage(error)}`);
    return { kind: "unreadable_folder" };
  }
  if (
    folderKeys.publishableKeys.length === 0 &&
    folderKeys.secretKeys.length === 0 &&
    (folderKeys.unreadableLines ?? []).length === 0
  ) {
    const sdkFile = folderKeys.sdkFile && folderKeys.sdkFile.state !== "absent";
    return { kind: sdkFile ? "unusable_sdk_file" : "no_keys" };
  }

  let checks = checkFolderKeys(folderKeys, app().instances);
  // Only an incomplete app is worth a fetch; a folder value the CLI can't
  // read stays unreadable whatever the app looks like.
  if (!checks.some(isMismatch) && checks.some(fetchMayHelp) && (await fetchOnce())) {
    checks = checkFolderKeys(folderKeys, app().instances);
  }
  return { kind: "compared", checks };
}

/** The mismatched key to name: the one the app loads, else a publishable key, else the first. */
function mismatchToName(mismatches: KeyCheck[], effective: FolderKeys | undefined): KeyCheck {
  return (
    mismatches.find((check) => isEffective(check, effective)) ??
    mismatches.find((check) => check.key === "publishable") ??
    mismatches[0]!
  );
}

function hasInstances(app: Application): boolean {
  // Deserialized API JSON: the array can be missing despite the type.
  return Array.isArray(app.instances) && app.instances.length > 0;
}

/**
 * - `unknown`: the claimed app's data lacked a comparable key; a fetch may settle it.
 * - `unreadable`: the folder's own value can't be read as a key (an unparseable
 *   line, a trailing comment, a `${VAR}` reference); nothing settles it.
 */
type KeyComparison = "match" | "mismatch" | "unknown" | "unreadable";

interface KeyCheck {
  key: "publishable" | "secret";
  name: string;
  source: string;
  result: KeyComparison;
}

const isMismatch = (check: KeyCheck) => check.result === "mismatch";
const fetchMayHelp = (check: KeyCheck) => check.result === "unknown";

/**
 * The keys `clerk link` would match with. `undefined` when they can't be
 * read, which only withholds the plain `clerk link` advice.
 */
async function effectiveKeys(cwd: string): Promise<FolderKeys | undefined> {
  try {
    return await readFolderKeys(cwd);
  } catch (error) {
    log.debug(`autoclaim: couldn't read the keys the app loads — ${errorMessage(error)}`);
    return undefined;
  }
}

function isEffective(check: KeyCheck, effective: FolderKeys | undefined): boolean {
  const key = check.key === "publishable" ? effective?.publishableKey : effective?.secretKey;
  return key !== undefined && key.name === check.name && key.source === check.source;
}

/** Whether `value` is exactly one of the claimed app's keys of that kind, in any format. */
function isOneOfTheAppsKeys(
  key: KeyCheck["key"],
  value: string,
  instances: readonly ApplicationInstance[],
): boolean {
  return instances.some(
    (instance) =>
      (key === "publishable" ? instance.publishable_key : instance.secret_key) === value,
  );
}

/** Compares every key the folder holds with the claimed app's instances. */
function checkFolderKeys(
  folderKeys: AllFolderKeys,
  instances: readonly ApplicationInstance[] | undefined,
): KeyCheck[] {
  // Deserialized API JSON: a missing array means there is nothing to compare
  // against, not a crash.
  const list = Array.isArray(instances) ? instances : [];
  const check = (
    key: KeyCheck["key"],
    { value, name, source }: LocatedKey,
    compare: (local: string, instances: readonly ApplicationInstance[]) => KeyComparison,
  ): KeyCheck => ({
    key,
    name,
    source,
    // A value not shaped like a Clerk key is unreadable rather than another
    // app's key. A legacy `test_`/`live_` key still matches when it's
    // identical to one of the claimed app's keys, checked first; otherwise it
    // fails safe as "couldn't tell".
    result: isOneOfTheAppsKeys(key, value, list)
      ? "match"
      : isClerkKeyShaped(value)
        ? compare(value, list)
        : "unreadable",
  });
  return [
    ...folderKeys.publishableKeys.map((located) =>
      check("publishable", located, comparePublishableKey),
    ),
    ...folderKeys.secretKeys.map((located) => check("secret", located, compareSecretKey)),
    ...(folderKeys.unreadableLines ?? []).map(({ kind, name, source }): KeyCheck => ({
      key: kind,
      name,
      source,
      result: "unreadable",
    })),
  ];
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

/**
 * Returns why linking failed, or `undefined` when it worked. Preserves the
 * orchestrator's never-throws contract: the claim already succeeded on the
 * server and the breadcrumb is cleared, so a local link failure must not
 * surface as a failed login. The caller prints the reason after the claim.
 */
async function tryLinkApp(app: Application, cwd: string): Promise<string | undefined> {
  try {
    if (await linkApp(app, cwd)) return undefined;
    return "the application has no development instance";
  } catch (error) {
    return errorMessage(error);
  }
}

/** Writes the linked app's keys into the folder the check read, not the process's working directory. */
async function tryPullEnv(cwd: string): Promise<boolean> {
  try {
    await pull({ cwd });
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
