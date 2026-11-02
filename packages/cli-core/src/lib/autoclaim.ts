import { join } from "node:path";
import { readKeylessBreadcrumb, clearKeylessBreadcrumb } from "./keyless.ts";
import { claimApplication, type Application } from "./plapi.ts";
import { ApiError, AuthError, CliError, PlapiError, errorMessage } from "./errors.ts";
import { linkApp } from "./autolink.ts";
import { ENV_FILE_CANDIDATES } from "./dotenv.ts";
import { deriveProjectName } from "./project-name.ts";
import { buildDashboardUrl } from "./environment.ts";
import { detectPublishableKeyName } from "./framework.ts";
import { pull } from "../commands/env/pull.ts";
import { log } from "./log.ts";

/** An env file the key check couldn't read, so the claimed app's keys weren't written. */
type UnreadableEnv = { file: string; reason: string };

type Claimed = {
  status: "claimed";
  app: Application;
  /** Whether the folder's link was saved. `linkError` says why not. */
  linked: boolean;
  linkError?: string;
  envPulled: boolean;
  unreadableEnv?: UnreadableEnv;
};
/** The claim can never succeed with this token; the breadcrumb is cleared. */
type Terminal = { status: "not_found" | "no_organization" };
/**
 * The token's workspace is provisioned by an integration (Vercel Marketplace,
 * Stripe), so nothing can be claimed into it. The breadcrumb is kept: the user
 * switches to a workspace they own and the next `clerk auth login` or `clerk link` retries.
 * `longMessage` is the API's `long_message`, which names the provider.
 */
type ManagedWorkspace = {
  status: "managed_workspace";
  longMessage: string | null;
  error: PlapiError;
};
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

/**
 * Orchestrates the claim of a keyless app. Never throws. `checkKeys` compares the folder's
 * publishable keys with the claimed app's before linking; `clerk init`, `clerk migrate` and
 * the `clerk doctor` fix sign in without it, so they keep linking whatever they claim.
 */
export async function attemptAutoclaim(
  cwd: string,
  { checkKeys }: { checkKeys: boolean },
): Promise<AutoclaimResult> {
  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (!breadcrumb) return { status: "not_keyless" };

  const appName = await deriveProjectName(cwd);
  const result = await tryClaim(breadcrumb.claimToken, appName);

  if (result.status === "failed" || result.status === "managed_workspace") return result;

  await clearKeylessBreadcrumb(cwd);

  if (result.status === "claimed") {
    const check = checkKeys ? await checkLocalKeys(result.app, cwd) : { sources: [] };
    if ("sources" in check && check.sources.length > 0) {
      return { status: "keys_mismatch", app: result.app, sources: check.sources };
    }
    const link = await tryLinkApp(result.app, cwd);
    if ("unreadable" in check) {
      return { ...result, ...link, envPulled: false, unreadableEnv: check.unreadable };
    }
    const envPulled = link.linked && (await tryPullEnv(cwd));
    return { ...result, ...link, envPulled };
  }

  return result;
}

/**
 * Where the folder holds a publishable key for another app, or the first env file that
 * couldn't be read. Covers the exported variable and the development env files
 * (`ENV_FILE_CANDIDATES`): `clerk env pull` writes `.env.development.local`, `.env.local` or
 * `.env`, and `.env.development` outranks `.env` in development, so a key there would override
 * the pulled one. Each file is read on its own: any mismatch refuses, and an unreadable file
 * only matters when no source mismatches, because it could hide one.
 */
async function checkLocalKeys(
  app: Application,
  cwd: string,
): Promise<{ sources: string[] } | { unreadable: UnreadableEnv }> {
  // Deserialized API JSON: a claim response without instances must not throw here.
  const expected = app.instances?.find(
    (instance) => instance.environment_type === "development",
  )?.publishable_key;
  if (!expected) return { sources: [] };

  const name = await detectPublishableKeyName(cwd);
  const sources: string[] = [];
  let unreadable: UnreadableEnv | undefined;

  const exported = normalizeKey(process.env[name] ?? "");
  if (exported && exported !== expected) sources.push(`${name} env var`);

  // Its own pattern, not `parseEnvFile`, which reads a CRLF line, an indented line or spaces
  // around `=` as a comment; frameworks read all three as entries. `name` is an identifier,
  // so it needs no escaping.
  const entry = new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=\\s*(.*)$`);

  for (const file of ENV_FILE_CANDIDATES) {
    try {
      const handle = Bun.file(join(cwd, file));
      if (!(await handle.exists())) continue;
      const lines = (await handle.text()).replace(/\r\n?/g, "\n").split("\n");
      const foreign = lines.some((line) => {
        const match = entry.exec(line);
        if (!match) return false;
        const value = normalizeKey(match[1] ?? "");
        return value !== "" && value !== expected;
      });
      if (foreign) sources.push(file);
    } catch (error) {
      log.debug(`autoclaim: could not read ${file}: ${errorMessage(error)}`);
      unreadable ??= { file, reason: errorMessage(error) };
    }
  }

  if (sources.length > 0) return { sources };
  if (unreadable) return { unreadable };
  return { sources: [] };
}

/**
 * The key as a framework reads it: cutting at the first whitespace drops trailing spaces and an
 * inline `# comment`, safe because publishable keys contain no spaces; then surrounding quotes go.
 */
function normalizeKey(value: string): string {
  const token = value.trim().split(/\s/)[0] ?? "";
  const quote = token[0];
  if ((quote === '"' || quote === "'") && token.length >= 2 && token.at(-1) === quote) {
    return token.slice(1, -1);
  }
  return token;
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
// succeeded on the server and the breadcrumb is cleared, so a local link
// failure must not surface as a failed login.
async function tryLinkApp(
  app: Application,
  cwd: string,
): Promise<{ linked: boolean; linkError?: string }> {
  try {
    const linked = await linkApp(app, cwd);
    if (!linked) return { linked: false, linkError: "the application has no development instance" };
    return { linked: true };
  } catch (error) {
    return { linked: false, linkError: errorMessage(error) };
  }
}

// Pulls into `cwd`, the folder the key check read, not the process's working directory.
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
    return { status: "managed_workspace", longMessage: error.longMessage, error };
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
};

export const CLAIM_OTHER_APP_HINT =
  "or run `clerk link --app <app_id>` to link a different application.";

/**
 * Why a claim failed and kept its token. A 5xx, a 429 or a network failure may pass on a
 * retry. An `AuthError` (a session that can't be refreshed) or a 401 means the credentials
 * were rejected, so `--app` would fail the same way; the Platform API client prefers
 * `CLERK_PLATFORM_API_KEY`, so with it set a 401 rejects the key, not the saved sign-in. Any
 * other `CliError` (e.g. `invalid_key_format`) is the CLI's own check and repeats on every
 * run, and its message already says what to fix. Any other 4xx repeats on every run.
 */
export type ClaimFailureKind = "temporary" | "sign_in" | "api_key" | "cli" | "rejected";

export function claimFailureKind(error: Error): ClaimFailureKind {
  if (error instanceof AuthError) return "sign_in";
  if (error instanceof CliError) return "cli";
  if (!(error instanceof ApiError) || error.status >= 500 || error.status === 429) {
    return "temporary";
  }
  if (error.status === 401) return process.env.CLERK_PLATFORM_API_KEY ? "api_key" : "sign_in";
  return "rejected";
}

/**
 * What `clerk link` and `clerk auth login` advise for each kind of failed claim. A `cli`
 * failure has none: its own message is the advice.
 */
export const CLAIM_FAILURE_ADVICE: Record<Exclude<ClaimFailureKind, "cli">, string> = {
  temporary:
    "Couldn't claim the application `clerk init` created because of a temporary error. " +
    `Rerun \`clerk link\` to retry, ${CLAIM_OTHER_APP_HINT}`,
  sign_in:
    "Clerk rejected the saved sign-in while claiming the application `clerk init` created. " +
    "Run `clerk auth login` to sign in again, then rerun `clerk link`.",
  api_key:
    "Clerk rejected `CLERK_PLATFORM_API_KEY` while claiming the application `clerk init` created. " +
    "Fix or unset it, then rerun `clerk link`.",
  rejected:
    "Clerk rejected the claim of the application `clerk init` created. " +
    "Run `clerk link --app <app_id>` with the application this folder should use.",
};

/** The warning `clerk auth login` and `clerk link` print for a claim that didn't link the folder. */
export function claimWarning(result: AutoclaimResult): string | undefined {
  if (result.status === "managed_workspace") {
    // The API message already names the provider and says what to do.
    return `Unable to claim - ${result.longMessage ?? "this workspace is managed by an integration provider."}`;
  }
  if (result.status === "keys_mismatch") return keysMismatchMessage(result);
  if (result.status === "failed") {
    const { error } = result;
    const kind = claimFailureKind(error);
    if (kind === "cli") return error.message;
    if (kind !== "rejected") return CLAIM_FAILURE_ADVICE[kind];
    const status = error instanceof ApiError ? ` (${error.status})` : "";
    return `${CLAIM_FAILURE_ADVICE.rejected} Clerk's reason${status}: ${error.message}`;
  }
  return CLAIM_WARNINGS[result.status];
}

/**
 * Prints what a successful claim did. `unlinkedHint` follows the warning when the folder wasn't
 * linked; `clerk link` passes none because it goes on to link the claimed app itself.
 */
export function reportClaimed(
  result: Extract<AutoclaimResult, { status: "claimed" }>,
  { unlinkedHint }: { unlinkedHint?: string } = {},
): void {
  const label = result.app.name || result.app.application_id;
  log.success(
    result.linked
      ? `Claimed and linked application: \`${label}\``
      : `Claimed application: \`${label}\``,
  );
  // First time this app has a home in an account; say where it is.
  // Deserialized API JSON; a missing array must not fail a claim that
  // already succeeded server-side.
  const development = result.app.instances?.find(
    (instance) => instance.environment_type === "development",
  );
  if (development) {
    // URL on its own line: with it, the sentence is wider than the frame.
    log.info("Your app now lives in your Clerk account:");
    log.info(`  ${buildDashboardUrl(result.app.application_id, development.instance_id)}`);
  }
  if (!result.linked && unlinkedHint) {
    log.warn(`This folder wasn't linked: ${result.linkError}. ${unlinkedHint}`);
  }
  if (result.unreadableEnv) {
    const { file, reason } = result.unreadableEnv;
    log.warn(
      `Couldn't read ${file} to check its publishable key (${reason}), so this folder's keys weren't written. ` +
        "Run `clerk env pull` once the file is fixed.",
    );
  }
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
