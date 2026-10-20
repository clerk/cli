import type { Program } from "../../cli-program.ts";
import { basename } from "node:path";
import { confirm } from "../../lib/prompts.ts";
import { isAgent } from "../../mode.ts";
import { getToken } from "../../lib/credential-store.ts";
import { login } from "../auth/login.ts";
import {
  claimWarning,
  claimedNextSteps,
  reportClaimSkipped,
  reportClaimed,
} from "../auth/claim-report.ts";
import {
  attemptAutoclaim,
  folderKeysBelongTo,
  readInitClaim,
  type InitClaim,
} from "../../lib/autoclaim.ts";
import { claimDestination, confirmClaim } from "../../lib/claim-prompt.ts";
import { signedInAccount } from "./account.ts";
import { linkSdkOnlyFolder } from "./sdk-only.ts";
import { declareSoftExitOutcome } from "../../lib/telemetry.ts";
import { createApplication, fetchApplication, type Application } from "../../lib/plapi.ts";
import { appLabel, fetchAppsTolerantly, pickOrCreateApp } from "../../lib/app-picker.ts";
import { setProfile, resolveProfile, moveProfile } from "../../lib/config.ts";
import { autolink, findLinkKey, matchKeyToApp } from "../../lib/autolink.ts";
import { getGitRepoIdentifier, getGitRepoRoot, getGitNormalizedRemote } from "../../lib/git.ts";
import { dim, cyan } from "../../lib/color.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import {
  CliError,
  ERROR_CODE,
  EXIT_CODE,
  throwUsageError,
  throwUserAbort,
  withApiContext,
} from "../../lib/errors.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { log } from "../../lib/log.ts";

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
   * Set by `clerk init`, which writes the linked app's keys next. After a
   * claim attempt (the folder had an init token), the link is saved only if
   * every Clerk key in the folder belongs to the chosen app; otherwise
   * nothing is saved and `link` stops with not_linked, naming the key. It's
   * the only way the folder never points at an app it doesn't run on.
   */
  onlyIfFolderKeysMatch?: boolean;
}

/**
 * What `link()` did. Callers stop when the folder isn't linked: after
 * `claim_page_opened`, a person claims the SDK's app in the Dashboard and
 * reruns `clerk link`.
 */
export type LinkOutcome = { status: "linked"; appId: string } | { status: "claim_page_opened" };

export async function link(options: LinkOptions = {}): Promise<LinkOutcome> {
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
    return { status: "linked", appId: existing.profile.appId };
  }

  // Claim first: a signed-in picker can't show the app `clerk init` created,
  // because it isn't in an account yet. An explicit `--app` or an existing
  // link wins, so neither claims.
  // The person's frame opens once, before the first thing they see, and every
  // return after that closes it. Agents print no frame.
  let framed = false;
  const openFrame = () => {
    if (framed) return;
    intro("Linking project");
    framed = true;
  };
  const showNextSteps = options.showNextSteps !== false;

  const initClaim = !existing && !options.app ? await readInitClaim(cwd) : undefined;
  if (initClaim) {
    openFrame();
    const claimed = await claimFirst(cwd, initClaim, agent, showNextSteps);
    if (claimed) return claimed;
  } else if (!existing && !options.app) {
    const sdkOnly = await linkSdkOnlyFolder(cwd, agent, openFrame);
    if (sdkOnly) {
      await outro(sdkOnly.status === "linked" && showNextSteps ? NEXT_STEPS.LINK : undefined);
      return sdkOnly;
    }
  }

  // After a claim attempt, `init` writes the chosen app's keys next: check
  // every key in the folder belongs to that app before saving the link.
  const checkFolderKeys =
    options.onlyIfFolderKeysMatch && initClaim
      ? async (target: Application) => requireFolderKeysBelongTo(target, cwd)
      : undefined;

  // Why the folder's own key couldn't pick its app, when the CLI can't tell
  // which key the app loads.
  let couldntTell: string | undefined;
  if (!existing && !options.app && (options.skipIfLinked || agent)) {
    const autolinked = await autolink(cwd, { beforeLink: checkFolderKeys });
    if (autolinked.status === "linked") {
      if (framed) await outro();
      return { status: "linked", appId: autolinked.profile.appId };
    }
    if (autolinked.status === "couldnt_tell") couldntTell = autolinked.reason;
  }

  // Neither "couldn't tell" nor a folder that had an init token creates an
  // app: `init` would then write the new app's keys over ones the CLI couldn't
  // attribute, or that the claim check just left alone.
  const mayCreate = Boolean(options.createIfMissing) && !couldntTell && !initClaim;
  if (agent && !existing && !options.app && !mayCreate) {
    // The lead sentence stays verbatim: agents and the skill's troubleshooting
    // table match on it.
    throwUsageError(
      `Cannot select an application in agent mode. ${couldntTell ? `${capitalize(couldntTell)}. ` : ""}Pass --app <id>, or run \`clerk apps list --json\` and retry.`,
    );
  }

  openFrame();

  if (existing && agent) {
    printExistingStatus(existing, normalizedRemote);
    if (!targetsDifferentApp) {
      await outro();
      return { status: "linked", appId: existing.profile.appId };
    }
  } else if (existing) {
    const shouldRelink = await handleExistingProfile(existing, normalizedRemote, options);
    if (!shouldRelink) {
      await outro();
      return { status: "linked", appId: existing.profile.appId };
    }
  }

  await ensureAuth();

  const app = options.app
    ? await withApiContext(fetchApplication(options.app), "Failed to fetch application")
    : agent && mayCreate && options.createIfMissing
      ? await withApiContext(
          createApplication(options.createIfMissing),
          "Failed to create application",
        )
      : await resolveApp(cwd, displayPath, !existing);

  await checkFolderKeys?.(app);

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
  return { status: "linked", appId: app.application_id };
}

/**
 * Claims the app `clerk init` created, as the first step of a link. Returns
 * the outcome when the claim linked the folder; undefined when `link` should
 * go on to match the folder's own key, which it does without ever creating an
 * app. Throws when the claim was refused (the folder stays unlinked) or
 * failed.
 *
 * A person is asked first, naming where the app will go; declining is a user
 * abort, before any picker. An agent can't answer, so it claims silently, and
 * one that isn't signed in can't sign in here, so it doesn't claim.
 */
async function claimFirst(
  cwd: string,
  initClaim: InitClaim,
  agent: boolean,
  showNextSteps: boolean,
): Promise<LinkOutcome | undefined> {
  if (agent) {
    if (!(await hasCredentials())) return undefined;
  } else {
    const account = await signedInAccount();
    const destination = claimDestination(account);
    // Signed in, so there's always a destination; without one, nothing is
    // claimed into an account the person wasn't told about.
    if (!destination) return undefined;
    const yes = await confirmClaim({ appName: initClaim.appName, destination });
    if (!yes) {
      if (account) reportClaimSkipped(initClaim.appName, account);
      await outro();
      throwUserAbort();
    }
  }

  const result = await attemptAutoclaim(cwd, initClaim);
  switch (result.status) {
    case "claimed":
      reportClaimed(result);
      if (result.local.kind === "linked") {
        await outro(showNextSteps ? claimedNextSteps(result) : undefined);
        return { status: "linked", appId: result.app.application_id };
      }
      return undefined;
    case "not_found":
      // The app may already be in the account, where the folder's key finds it.
      log.warn(claimWarning(result) ?? "");
      return undefined;
    case "managed_workspace":
    case "no_organization":
      throw new CliError(`${claimWarning(result)} This folder isn't linked.`, {
        code: ERROR_CODE.NOT_LINKED,
      });
    case "failed":
      throw result.error;
  }
}

/**
 * Stops the link, saving nothing, unless every Clerk key in the folder
 * belongs to `app`: `init` would otherwise write `app`'s keys next to another
 * app's, and the folder would point at an app it doesn't run on. "Couldn't
 * tell" stops too.
 */
async function requireFolderKeysBelongTo(app: Application, cwd: string): Promise<void> {
  const result = await folderKeysBelongTo(app, cwd);
  if (result.verdict === "match") return;
  const label = `\`${app.name || app.application_id}\``;
  const which = result.key
    ? `\`${result.key.name}\` in ${result.key.source}`
    : "this folder's Clerk keys";
  const problem =
    result.verdict === "mismatch"
      ? `${which} isn't ${label}'s`
      : `The CLI couldn't confirm ${which} belongs to ${label}`;
  throw new CliError(
    `${capitalize(problem)}, so this folder wasn't linked to ${label} and no keys were written. Make the folder's Clerk keys belong to one application, then run \`clerk init\` again.`,
    { code: ERROR_CODE.NOT_LINKED },
  );
}

async function hasCredentials(): Promise<boolean> {
  return Boolean(process.env.CLERK_PLATFORM_API_KEY) || Boolean(await getToken());
}

async function ensureAuth() {
  // CLERK_PLATFORM_API_KEY is a valid non-interactive auth mechanism.
  // The PLAPI fetch helpers use it directly for API calls, so no OAuth
  // token is needed when this key is present.
  if (process.env.CLERK_PLATFORM_API_KEY) return;
  const token = await getToken();
  if (!token) {
    log.info("Not logged in. Authenticating first...");
    // `link` applies the claim rule itself, before it gets here.
    await login({ showNextSteps: false, claim: false });
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
  const found = await findLinkKey(cwd);
  if (found.status === "couldnt_tell") {
    log.info(`${capitalize(found.reason)}, so choose the application this folder should use.`);
    return undefined;
  }
  if (found.status === "none") return undefined;

  const match = matchKeyToApp([{ key: found.key.value, source: found.key.source }], apps);
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

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
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
    // Only `--app`: internal options such as `createIfMissing` stay internal.
    .action(async (opts: { app?: string }) => {
      const outcome = await link({ app: opts.app });
      // Nothing was linked: `clerk link && clerk deploy` must stop here, since
      // `deploy` would only fail with not_linked. The person did their part,
      // so no error line; telemetry records an unfinished link, not a failure.
      if (outcome.status === "claim_page_opened") {
        declareSoftExitOutcome("incomplete", ERROR_CODE.NOT_LINKED);
        process.exitCode = EXIT_CODE.GENERAL;
      }
    });
}
