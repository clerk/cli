import type { Program } from "../../cli-program.ts";
import { basename } from "node:path";
import { confirm } from "../../lib/prompts.ts";
import { isAgent } from "../../mode.ts";
import { getToken, hasAccountCredentials } from "../../lib/credential-store.ts";
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
import {
  createApplication,
  fetchApplication,
  listApplications,
  type Application,
} from "../../lib/plapi.ts";
import { appLabel, fetchAppsTolerantly, pickOrCreateApp } from "../../lib/app-picker.ts";
import { setProfile, resolveProfile, moveProfile } from "../../lib/config.ts";
import { autolink, findLinkKey, matchKeyToApp, type AutolinkResult } from "../../lib/autolink.ts";
import {
  couldntTellReason,
  describeKeyLocation,
  isClerkKeyShaped,
  mayBeAnAppsKey,
  readAllFolderKeys,
  readFolderKeys,
  SDK_KEYLESS_SOURCE,
  secretKeysDisagreeReason,
  unreadableFolderReason,
  type AllFolderKeys,
  type FolderKeys,
} from "../../lib/local-keys.ts";
import { decodePublishableKey } from "../../lib/publishable-key.ts";
import { getGitRepoIdentifier, getGitRepoRoot, getGitNormalizedRemote } from "../../lib/git.ts";
import { dim, cyan } from "../../lib/color.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { capitalize } from "../../lib/text.ts";
import {
  CliError,
  ERROR_CODE,
  EXIT_CODE,
  errorMessage,
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
  /**
   * What to tell a person to run after claiming an SDK-created app on its
   * claim page, as a clause. Default "run `clerk link` again"; `init` and
   * `migrate` name themselves, since rerunning `link` alone wouldn't finish
   * their work.
   */
  rerun?: string;
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

  // The person's frame opens once, before the first thing they see, and every
  // return after that closes it. Agents print no frame.
  let framed = false;
  const openFrame = () => {
    if (framed) return;
    intro("Linking project");
    framed = true;
  };
  const showNextSteps = options.showNextSteps !== false;
  const rerun = options.rerun ?? "run `clerk link` again";

  // Claim first: a signed-in picker can't show the app `clerk init` created,
  // because it isn't in an account yet. An explicit `--app` or an existing
  // link wins, so neither claims.
  const initClaim = !existing && !options.app ? await readInitClaim(cwd) : undefined;
  if (initClaim) {
    openFrame();
    const claimed = await claimFirst(cwd, initClaim, agent, showNextSteps);
    if (claimed) return claimed;
  }

  // After a claim attempt, `init` writes the chosen app's keys next: check
  // every key in the folder belongs to that app before saving the link.
  const checkFolderKeys =
    options.onlyIfFolderKeysMatch && initClaim
      ? async (target: Application) => requireFolderKeysBelongTo(target, cwd)
      : undefined;

  let step: NextStep | undefined;
  if (!existing && !options.app) {
    const folder = await inspectFolder(cwd);

    // After a claim that didn't link the folder, the token is gone, so a
    // folder whose only keys are the SDK's is SDK-only too.
    if (folder.keys) {
      const sdkOnly = await linkSdkOnlyFolder(cwd, agent, {
        keys: folder.keys,
        openFrame,
        beforeLink: checkFolderKeys,
        rerun,
      });
      if (sdkOnly) {
        await outro(sdkOnly.status === "linked" && showNextSteps ? NEXT_STEPS.LINK : undefined);
        return sdkOnly;
      }
    }

    let autolinked: AutolinkResult | undefined;
    if (options.skipIfLinked || agent) {
      autolinked = await autolink(cwd, { beforeLink: checkFolderKeys });
      if (autolinked.status === "linked") {
        if (framed) await outro();
        return { status: "linked", appId: autolinked.profile.appId };
      }
    }

    step = decideNextStep({
      agent,
      autolinked,
      folder,
      createIfMissing: options.createIfMissing,
      afterClaim: Boolean(initClaim),
      keyCheck: Boolean(checkFolderKeys),
    });
    if (step.kind === "stop") throw step.error;
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
    : step?.kind === "create"
      ? await withApiContext(createApplication(step.name), "Failed to create application")
      : await resolveApp(
          cwd,
          displayPath,
          step?.kind === "pick" ? step : { detect: !existing, allowCreate: true },
        );

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

/** What `link` read about the folder's keys, for deciding what it may do. */
interface FolderFacts {
  /** The keys the folder's app loads; undefined when an env file it loads couldn't be read. */
  keys?: FolderKeys;
  /** Why the CLI can't tell which publishable key the app loads, as a clause. */
  couldntTell?: string;
  /** Why the folder's secret keys are undecided, as a clause. */
  secretsDisagree?: string;
  /**
   * Why an env file couldn't be read, as a clause. Even a file the framework
   * doesn't load may hold a real app's keys.
   */
  readError?: string;
  /**
   * Why no app can pass `init`'s every-key check, as a clause: an env file or
   * a key line can't be read, a value can't be any app's key, or an SDK
   * keyless file names no app.
   */
  unreadable?: string;
  /**
   * The folder holds a Clerk key value (placeholders included), a line naming
   * one, or an SDK keyless file. A new app's keys can't match any of them.
   */
  holdsKeys: boolean;
}

/**
 * Reads the folder's keys once; a read error is carried, never thrown. The two
 * reads fail apart: `readAllFolderKeys` also reads env files the framework
 * doesn't load (Nuxt loads only `.env`), so when only it fails, the keys the
 * app loads, and the SDK-only step, still stand.
 */
async function inspectFolder(cwd: string): Promise<FolderFacts> {
  const [loaded, every] = await Promise.allSettled([readFolderKeys(cwd), readAllFolderKeys(cwd)]);
  if (loaded.status === "rejected") {
    const reason = unreadableFolderReason(loaded.reason);
    return { couldntTell: reason, readError: reason, unreadable: reason, holdsKeys: true };
  }
  const keys = loaded.value;
  const facts = {
    keys,
    couldntTell: couldntTellReason(keys),
    secretsDisagree: secretKeysDisagreeReason(keys),
  };
  if (every.status === "rejected") {
    // No app can pass `init`'s every-key check, which reads every file.
    const readError = unreadableFolderReason(every.reason);
    return { ...facts, readError, unreadable: readError, holdsKeys: true };
  }
  const all = every.value;
  const anyKey = all.publishableKeys.length > 0 || all.secretKeys.length > 0;
  const sdkFile = Boolean(all.sdkFile) && all.sdkFile?.state !== "absent";
  return {
    ...facts,
    unreadable: noAppCanPass(all),
    holdsKeys: anyKey || Boolean(all.unreadableLines?.length) || sdkFile,
  };
}

/**
 * Why no app can pass `init`'s every-key check, as a clause; undefined when
 * one may. The check compares every key with the app's, and a value that
 * can't be any app's key (a placeholder, say) never compares as a match.
 * Names the variable and its file, never the value.
 */
function noAppCanPass(all: AllFolderKeys): string | undefined {
  const line = all.unreadableLines?.[0];
  if (line) return `the CLI couldn't read the \`${line.name}\` line in \`${line.source}\``;
  const notAKey =
    all.publishableKeys.find((key) => !mayBeAnAppsPublishableKey(key.value)) ??
    all.secretKeys.find((key) => !mayBeAnAppsKey(key.value));
  if (notAKey) {
    return `${describeKeyLocation(notAKey)} doesn't hold a value the CLI can read as a Clerk key`;
  }
  if (isUnusable(all)) {
    return `this folder's Clerk SDK keyless file (\`${SDK_KEYLESS_SOURCE}\`) names no app`;
  }
  return undefined;
}

/**
 * Whether a publishable value could be an app's. Every app's publishable key
 * decodes to its Frontend API host, so a key-shaped placeholder
 * (`pk_test_xxxxxxxxxxxx`) can't be one. A legacy key can still match exactly.
 */
function mayBeAnAppsPublishableKey(value: string): boolean {
  if (!mayBeAnAppsKey(value)) return false;
  if (!isClerkKeyShaped(value)) return true;
  try {
    decodePublishableKey(value);
    return true;
  } catch {
    return false;
  }
}

/** An SDK keyless file that can't be read, or holds no key, names no app. */
function isUnusable(all: AllFolderKeys): boolean {
  return (
    all.sdkFile?.state === "unreadable" ||
    (all.sdkFile?.state === "parsed" && !all.publishableKeys.length && !all.secretKeys.length)
  );
}

/** What `link` does when auto-link didn't link the folder. */
type NextStep =
  | { kind: "create"; name: string }
  | { kind: "pick"; detect: boolean; allowCreate: boolean; why?: string }
  | { kind: "stop"; error: Error };

/**
 * One decision for every way auto-link can fail to link, so no path creates
 * an app, or reaches a picker, that it shouldn't.
 *
 * - The folder's key belongs to an app with no development instance: stop.
 * - `init`'s every-key check applies and no app can pass it: stop before the
 *   picker. Files that disagree aren't such a case: they may be one app's
 *   development and production keys.
 * - A person picks, without "Create" when the check applies and the folder
 *   holds keys, since a new app's keys couldn't match them.
 * - An agent creates an app only when auto-link found no key, or a key no
 *   account app holds (`autolinkAllowsCreate`), and nothing blocks it
 *   (`createBlockers`). Otherwise it stops, saying why.
 */
function decideNextStep(input: {
  agent: boolean;
  autolinked?: AutolinkResult;
  folder: FolderFacts;
  createIfMissing?: string;
  afterClaim: boolean;
  keyCheck: boolean;
}): NextStep {
  const { agent, autolinked } = input;
  // Auto-link read the same keys; its reason stands when it gives one.
  const folder: FolderFacts = {
    ...input.folder,
    couldntTell:
      autolinked?.status === "couldnt_tell" ? autolinked.reason : input.folder.couldntTell,
  };
  const { keyCheck } = input;
  if (autolinked?.status === "no_development_instance") {
    return {
      kind: "stop",
      error: new CliError("Application has no development instance", {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
      }),
    };
  }
  if (keyCheck && folder.unreadable) {
    // What keeps every app from passing comes first: "couldn't tell" alone
    // would still allow a pick.
    const why = folder.unreadable ?? folder.couldntTell;
    return {
      kind: "stop",
      error: new CliError(
        `${capitalize(why)}, so no application can be confirmed to own this folder's keys, and it wasn't linked. Make the folder's Clerk keys readable and belong to one application, then run \`clerk init\` again.`,
        { code: ERROR_CODE.NOT_LINKED },
      ),
    };
  }
  if (!agent) {
    return {
      kind: "pick",
      detect: !folder.couldntTell,
      allowCreate: !(keyCheck && folder.holdsKeys),
      why: folder.couldntTell,
    };
  }
  const blockers = createBlockers(autolinked, folder, input.afterClaim);
  if (input.createIfMissing && autolinkAllowsCreate(autolinked) && blockers.length === 0) {
    return { kind: "create", name: input.createIfMissing };
  }
  const reason = blockers.map(describeBlocker).find((clause) => clause !== undefined);
  // The lead sentence stays verbatim: agents and the skill's troubleshooting
  // table match on it.
  return {
    kind: "stop",
    error: new CliError(
      `Cannot select an application in agent mode. ${reason ? `${capitalize(reason)}. ` : ""}Pass --app <id>, or run \`clerk apps list --json\` and retry.`,
      { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE },
    ),
  };
}

/**
 * Whether auto-link's outcome leaves room for a new app: it found no key, or a
 * key no account app holds. Every outcome is listed, so a new one fails the
 * typecheck here until someone decides whether it may create.
 */
function autolinkAllowsCreate(autolinked: AutolinkResult | undefined): boolean {
  if (!autolinked) return false;
  switch (autolinked.status) {
    case "no_key":
    case "no_match":
      return true;
    case "linked":
    case "couldnt_tell":
    case "list_failed":
    case "no_development_instance":
      return false;
  }
}

/**
 * Something that stops an agent from creating a new app for the folder:
 * `init` would write the new app's keys over the folder's, and each is a case
 * where those keys may belong to a real app.
 */
type CreateBlocker =
  | { kind: "after_claim" }
  | { kind: "couldnt_tell"; reason: string }
  | { kind: "unreadable_file"; reason: string }
  | { kind: "list_failed"; error: unknown }
  | { kind: "secrets_disagree"; reason: string };

/** Everything that stops an agent from creating an app, in the order its message names them. */
function createBlockers(
  autolinked: AutolinkResult | undefined,
  folder: FolderFacts,
  afterClaim: boolean,
): CreateBlocker[] {
  const blockers: CreateBlocker[] = [];
  // The claim check may just have left the folder's keys alone.
  if (afterClaim) blockers.push({ kind: "after_claim" });
  if (folder.couldntTell) blockers.push({ kind: "couldnt_tell", reason: folder.couldntTell });
  if (folder.readError) blockers.push({ kind: "unreadable_file", reason: folder.readError });
  if (autolinked?.status === "list_failed") {
    blockers.push({ kind: "list_failed", error: autolinked.error });
  }
  if (folder.secretsDisagree) {
    blockers.push({ kind: "secrets_disagree", reason: folder.secretsDisagree });
  }
  return blockers;
}

/** What the agent's stop says about a blocker, as a clause; undefined when it adds nothing. */
function describeBlocker(blocker: CreateBlocker): string | undefined {
  switch (blocker.kind) {
    case "after_claim":
      // A claim that ran already reported its outcome; otherwise the existing
      // agent error stands.
      return undefined;
    case "couldnt_tell":
    case "unreadable_file":
    case "secrets_disagree":
      return blocker.reason;
    case "list_failed":
      return `the CLI couldn't list your applications to match this folder's key (${errorMessage(blocker.error)})`;
  }
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
    if (!(await hasAccountCredentials())) return undefined;
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
      // `link` goes on to link the folder itself: no next command to name.
      reportClaimed(result, { insideLink: true });
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
  const which = result.key ? describeKeyLocation(result.key) : "this folder's Clerk keys";
  const problem =
    result.verdict === "mismatch"
      ? `${which} isn't ${label}'s`
      : `The CLI couldn't confirm ${which} belongs to ${label}`;
  throw new CliError(
    `${capitalize(problem)}, so this folder wasn't linked to ${label} and no keys were written. Make the folder's Clerk keys, and any exported in your shell, belong to one application, then run \`clerk init\` again.`,
    { code: ERROR_CODE.NOT_LINKED },
  );
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
  if (found.status !== "found") return undefined;

  const match = matchKeyToApp([{ key: found.key.value, source: found.key.source }], apps);
  if (!match) return undefined;

  log.info(`We found ${cyan(appLabel(match.app))} from ${dim(match.source)}.`);
  const useDetected = await confirm({ message: "Link to this application?", default: true });
  return useDetected ? match.app : undefined;
}

async function resolveApp(
  cwd: string,
  displayPath: string,
  { detect, allowCreate, why }: { detect: boolean; allowCreate: boolean; why?: string },
): Promise<Application> {
  // Said before the list, so a person whose account has no apps hears it too.
  if (why) log.info(`${capitalize(why)}, so choose the application this folder should use.`);

  // With "Create" off, a failed list can't fall back to a create-only picker.
  const apps = allowCreate
    ? await fetchAppsTolerantly()
    : await withApiContext(listApplications(), "Failed to fetch applications");

  if (apps.length > 0 && detect) {
    const detected = await tryDetectApp(cwd, apps);
    if (detected) return detected;
  }

  if (!allowCreate && apps.length === 0) {
    throw new CliError(
      "No application in your account can be linked to this folder, and creating one here would replace the Clerk keys it holds, so it wasn't linked. Link an existing application with `clerk link --app <app_id>`.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  return pickOrCreateApp({
    apps,
    message: `Select a Clerk application to link ${dim(`(repo: ${basename(displayPath)})`)}`,
    allowCreate,
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
