import type { Program } from "../../cli-program.ts";
import { basename } from "node:path";
import { confirm } from "../../lib/prompts.ts";
import { isAgent } from "../../mode.ts";
import { getToken } from "../../lib/credential-store.ts";
import { login } from "../auth/login.ts";
import { createApplication, fetchApplication, type Application } from "../../lib/plapi.ts";
import { appLabel, fetchAppsTolerantly, pickOrCreateApp } from "../../lib/app-picker.ts";
import { setProfile, resolveProfile, moveProfile } from "../../lib/config.ts";
import { autolink, findClerkKeys, matchKeyToApp } from "../../lib/autolink.ts";
import { getGitRepoIdentifier, getGitRepoRoot, getGitNormalizedRemote } from "../../lib/git.ts";
import { dim, cyan } from "../../lib/color.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import {
  ApiError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  withApiContext,
} from "../../lib/errors.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";
import { readKeylessBreadcrumb } from "../../lib/keyless.ts";
import {
  attemptAutoclaim,
  claimWarning,
  keysMismatchMessage,
  reportClaimed,
} from "../../lib/autoclaim.ts";

interface LinkOptions {
  app?: string;
  skipIfLinked?: boolean;
  cwd?: string;
  /**
   * In agent mode without `--app` and no existing profile, auto-create a new
   * Clerk application with this name and link to it instead of failing with a
   * usage error. Used by `clerk init` to keep the authed-agent flow non-
   * interactive end-to-end.
   */
  createIfMissing?: string;
  /** Callers that continue setup themselves (native `clerk init`) skip link's own next steps. */
  showNextSteps?: boolean;
  /**
   * Claim the application a signed-out `clerk init` left a claim token for, before listing
   * apps. Set only by the `clerk link` command; `clerk init`, `clerk migrate` and the
   * `clerk doctor` fix call `link()` without it. Signing in through `login()` still claims,
   * without the key check, on every path that doesn't run this step: other callers, and
   * `clerk link --app` or a relink when signed out.
   */
  claimKeylessApp?: boolean;
}

/**
 * The link that linking `cwd` to `app` would replace, if any. Inside a Git repository a link is
 * stored for the whole repository (by remote, else by its Git directory), so relinking any folder
 * in it moves every project there to `app`. Outside one, only a link stored for `cwd` itself is
 * replaced. A `newProject` doesn't exist yet, so outside a repository it never replaces one.
 */
export async function replacedLink(
  cwd: string,
  app: string,
  { newProject = false }: { newProject?: boolean } = {},
): Promise<{ appId: string; appName?: string; scope: string } | undefined> {
  const existing = await resolveProfile(cwd);
  if (!existing || existing.profile.appId === app) return undefined;
  const repoRoot = await getGitRepoRoot(cwd);
  if (!repoRoot && (newProject || existing.path !== cwd)) return undefined;
  return {
    appId: existing.profile.appId,
    appName: existing.profile.appName || undefined,
    scope: repoRoot ?? cwd,
  };
}

export async function link(options: LinkOptions = {}): Promise<void> {
  const agent = isAgent();
  const cwd = options.cwd ?? process.cwd();
  const repoRoot = await getGitRepoRoot(cwd);
  const normalizedRemote = await getGitNormalizedRemote(cwd);
  const repoId = await getGitRepoIdentifier(cwd);
  const profileKey = normalizedRemote ?? repoId ?? cwd;
  const displayPath = repoRoot ?? cwd;

  const existing = await resolveProfile(cwd);
  const targetsDifferentApp = options.app && existing && options.app !== existing.profile.appId;

  if (existing && options.skipIfLinked && !targetsDifferentApp) {
    printExistingStatus(existing, normalizedRemote);
    return;
  }

  let introShown = false;
  let claimedApp: Application | undefined;
  if (options.claimKeylessApp && !existing && !options.app) {
    const outcome = await claimKeylessApp(cwd, options);
    if (outcome.kind === "linked") return;
    introShown = outcome.kind !== "no_breadcrumb";
    if (outcome.kind === "claimed_unlinked") claimedApp = outcome.app;
  }

  if (!claimedApp && !existing && !options.app && (options.skipIfLinked || agent)) {
    const autolinked = await autolink(cwd);
    if (autolinked) return;
  }

  if (!claimedApp && agent && !existing && !options.app && !options.createIfMissing) {
    throwUsageError(
      "Cannot select an application in agent mode. Pass --app <id>, or run `clerk apps list --json` and retry.",
    );
  }

  if (!introShown) intro("Linking project");

  if (existing && agent) {
    printExistingStatus(existing, normalizedRemote);
    if (!targetsDifferentApp) {
      await outro();
      return;
    }
  } else if (existing) {
    const shouldRelink = await handleExistingProfile(existing, normalizedRemote, options);
    if (!shouldRelink) {
      await outro();
      return;
    }
  }

  await ensureAuth();

  // A claimed app that didn't link is linked here, as `--app <its id>` would: a missing
  // development instance or a failed config write then reports its own error.
  const app =
    claimedApp ??
    (options.app
      ? await withApiContext(fetchApplication(options.app), "Failed to fetch application")
      : agent && options.createIfMissing
        ? await withApiContext(
            createApplication(options.createIfMissing),
            "Failed to create application",
          )
        : await resolveApp(cwd, displayPath, !existing));

  const devInstance = app.instances.find((i) => i.environment_type === "development");
  const prodInstance = app.instances.find((i) => i.environment_type === "production");

  if (!devInstance) {
    throw new CliError("Application has no development instance", {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }

  await setProfile(profileKey, {
    workspaceId: "",
    appId: app.application_id,
    appName: app.name,
    instances: {
      development: devInstance.instance_id,
      ...(prodInstance ? { production: prodInstance.instance_id } : {}),
    },
  });

  const label = app.name || app.application_id;
  log.success(`Linked to ${cyan(label)} in ${dim(displayPath)}`);

  await outro(options.showNextSteps === false ? undefined : NEXT_STEPS.LINK);
}

const OTHER_APP_HINT = "or run `clerk link --app <app_id>` to link a different application.";

type ClaimOutcome =
  | { kind: "no_breadcrumb" }
  | { kind: "linked" }
  | { kind: "claimed_unlinked"; app: Application }
  | { kind: "not_claimed" };

/**
 * `linked` when the claim linked the folder, `claimed_unlinked` when `link()` must link the
 * claimed app itself, `not_claimed` (after printing why) when the token is spent and `link()`
 * carries on as usual. Throws on a key mismatch, and on a failure that keeps the token,
 * because no picker or app list can show the app the token claims.
 */
async function claimKeylessApp(cwd: string, options: LinkOptions): Promise<ClaimOutcome> {
  const breadcrumb = await readKeylessBreadcrumb(cwd);
  if (!breadcrumb?.claimToken) return { kind: "no_breadcrumb" };

  intro("Linking project");
  // `login()` would claim on its own and swallow a key mismatch as a warning.
  await ensureAuth({ claim: false });
  const result = await attemptAutoclaim(cwd, { checkKeys: true });

  switch (result.status) {
    case "keys_mismatch":
      throw new CliError(keysMismatchMessage(result), { code: ERROR_CODE.KEY_PAIR_MISMATCH });
    case "failed":
      throw claimFailure(result.error);
    case "managed_workspace":
      throw withAdvice(
        result.error,
        `Unable to claim - ${result.longMessage ?? "this workspace is managed by an integration provider."} ` +
          `Switch to a workspace you own and rerun \`clerk link\`, ${OTHER_APP_HINT}`,
      );
    case "claimed":
      reportClaimed(result);
      if (!result.linked) return { kind: "claimed_unlinked", app: result.app };
      await outro(
        options.showNextSteps === false
          ? undefined
          : result.envPulled
            ? NEXT_STEPS.AUTOCLAIMED
            : NEXT_STEPS.AUTOCLAIMED_NO_ENV,
      );
      return { kind: "linked" };
    default: {
      const warning = claimWarning(result);
      if (warning) log.warn(warning);
      return { kind: "not_claimed" };
    }
  }
}

const TEMPORARY_ADVICE =
  "Couldn't claim the application `clerk init` created because of a temporary error. " +
  `Rerun \`clerk link\` to retry, ${OTHER_APP_HINT}`;

/**
 * A 5xx, a 429 or a network failure may pass, so the advice is to retry; any other 4xx will
 * repeat on every run, so it points at `--app`.
 */
function claimFailure(error: Error): Error {
  if (!(error instanceof ApiError)) {
    // Reported like any other network failure; the advice has no other place to go.
    log.warn(TEMPORARY_ADVICE);
    return error;
  }
  if (error.status >= 500 || error.status === 429) return withAdvice(error, TEMPORARY_ADVICE);
  return withAdvice(
    error,
    "Clerk rejected the claim of the application `clerk init` created. " +
      "Run `clerk link --app <app_id>` with the application this folder should use",
  );
}

/**
 * Puts the advice in the API error's prefix, so the agent JSON carries it in `message` next
 * to the API's own code, printed once: "<advice> (<status>): <reason>".
 */
function withAdvice(error: ApiError, advice: string): ApiError {
  error.context = advice.replace(/\.$/, "");
  return error;
}

async function ensureAuth({ claim }: { claim?: boolean } = {}) {
  // CLERK_PLATFORM_API_KEY is a valid non-interactive auth mechanism.
  // The PLAPI fetch helpers use it directly for API calls, so no OAuth
  // token is needed when this key is present.
  if (process.env.CLERK_PLATFORM_API_KEY) return;
  const token = await getToken();
  if (!token) {
    log.info("Not logged in. Authenticating first...");
    await login(claim === false ? { showNextSteps: false, claim } : { showNextSteps: false });
  }
}

function printExistingStatus(
  existing: Awaited<ReturnType<typeof resolveProfile>> & {},
  normalizedRemote: string | undefined,
) {
  if (existing.resolvedVia === "remote") {
    log.info(`Auto-linked via git remote (${dim(normalizedRemote ?? existing.path)})`);
  } else {
    const label = existing.profile.appName
      ? `${existing.profile.appName} (${existing.profile.appId})`
      : existing.profile.appId;
    log.info(`Already linked to ${cyan(label)} in ${dim(existing.path)}`);
  }
}

async function handleExistingProfile(
  existing: Awaited<ReturnType<typeof resolveProfile>> & {},
  normalizedRemote: string | undefined,
  options: LinkOptions,
): Promise<boolean> {
  printExistingStatus(existing, normalizedRemote);

  if (existing.availableRemote) {
    log.info(
      `We detected this is now a git repository with remote ${dim(existing.availableRemote)}.`,
    );
    const upgrade = await confirm({
      message: "Update the link to use the git remote? This shares it across clones and worktrees.",
      default: true,
    });
    if (upgrade) {
      await moveProfile(existing.path, existing.availableRemote);
      log.info(`\nLink updated to use git remote (${cyan(existing.availableRemote)})`);
      return false;
    }
  }

  if (options.app) {
    await ensureAuth();
    const targetApp = await withApiContext(
      fetchApplication(options.app),
      "Failed to fetch application",
    );
    return confirm({ message: `Re-link to ${cyan(appLabel(targetApp))}?`, default: false });
  }

  return confirm({ message: "Re-link to a different application?", default: false });
}

async function tryDetectApp(cwd: string, apps: Application[]): Promise<Application | undefined> {
  const detectedKeys = await findClerkKeys(cwd);
  if (!detectedKeys.length) return undefined;

  const match = matchKeyToApp(detectedKeys, apps);
  if (!match) return undefined;

  log.info(`We found ${cyan(appLabel(match.app))} from ${dim(match.source)}.`);
  const useDetected = await confirm({ message: "Link to this application?", default: true });
  return useDetected ? match.app : undefined;
}

async function resolveApp(
  cwd: string,
  displayPath: string,
  detectKeys: boolean,
): Promise<Application> {
  const apps = await fetchAppsTolerantly();

  if (apps.length > 0 && detectKeys) {
    const detected = await tryDetectApp(cwd, apps);
    if (detected) return detected;
  }

  return pickOrCreateApp({
    apps,
    message: `Select a Clerk application to link ${dim(`(repo: ${basename(displayPath)})`)}`,
  });
}

export function registerLink(program: Program): void {
  program
    .command("link")
    .description("Link this project to a Clerk application")
    .option("--app <id>", "Application ID to link (skips interactive picker)")
    .setExamples([
      { command: "clerk link", description: "Pick an app interactively" },
      { command: "clerk link --app app_abc123", description: "Link directly by application ID" },
    ])
    .action(async (options: LinkOptions) => link({ ...options, claimKeylessApp: true }));
}
