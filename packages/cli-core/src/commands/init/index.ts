import { createOption } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { login } from "../auth/login.js";
import { link, replacedLink } from "../link/index.js";
import { pull } from "../env/pull.js";
import { isAgent, setMode } from "../../mode.js";
import { dim, bold } from "../../lib/color.js";
import {
  throwUserAbort,
  throwUsageError,
  UserAbortError,
  CliError,
  ERROR_CODE,
  EXIT_CODE,
  errorMessage,
  withApiContext,
} from "../../lib/errors.js";
import {
  lookupFramework,
  isNpmFramework,
  FRAMEWORK_NAMES,
  type FrameworkInfo,
} from "../../lib/framework.js";
import { resolveProfile } from "../../lib/config.js";
import { getGitRepoRoot } from "../../lib/git.js";
import { createApplication } from "../../lib/plapi.js";
import { deriveProjectName } from "../../lib/project-name.js";
import { log } from "../../lib/log.js";
import { quoteArg } from "../../lib/json-body.ts";
import { setTelemetryStage } from "../../lib/telemetry.ts";
import { confirm } from "../../lib/prompts.ts";
import {
  createAccountlessApp,
  writeKeysToEnvFile,
  parseClaimToken,
  writeKeylessBreadcrumb,
  readKeylessBreadcrumb,
  KEYLESS_TEMPLATES,
  type KeylessTemplate,
} from "../../lib/keyless.js";
import { readSdkKeylessApp } from "../../lib/keyless-target.ts";
import { interruptedExitCode } from "../../lib/signals.ts";
import { printAgentNextSteps, printNextSteps } from "../../lib/next-steps.js";
import { gatherContext, hasPackageJson } from "./context.js";
import { scaffold, enrichProjectContext } from "./scaffold.js";
import { previewPlan, previewAndConfirm } from "./preview.js";
import { runFormatters } from "./format.js";
import { detectAuthLibraries, scanForIssues } from "./scan.js";
import {
  installSdk,
  installDeps,
  writePlan,
  checkGitDirty,
  printOutro,
  printKeylessInfo,
  printExistingKeylessInfo,
  getAuthenticatedEmail,
  isAuthenticated,
} from "./heuristics.js";
import { installSkills } from "./skills.js";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.js";
import {
  promptAndBootstrap,
  rejectAccountlessApple,
  confirmOverwrite,
  type BootstrapOverrides,
  type BootstrapResult,
} from "./bootstrap.js";
import type { ProjectContext } from "./frameworks/types.js";
import { type PackageManager, PACKAGE_MANAGERS } from "../../lib/package-manager.ts";
import {
  applicationRequired,
  canSetUpXcode,
  runAppleInit,
  applicationInterrupted,
  inspectAppleProject,
  setupInterrupted,
  type AppleInitOptions,
  type StarterProjectSummary,
} from "./ios/coordinator.js";
import { withNativeProgress } from "./ios/progress.js";
import { SelectionNeeded } from "./ios/discovery.js";
import { IdentityRequired } from "./ios/identity.js";
import { StarterInputRequired, type AppleStarter } from "./ios/starter-bootstrap.js";

type InitOptions = Omit<AppleInitOptions, "root" | "agent"> & {
  /** Framework to set up (skips auto-detection). */
  framework?: string;
  pm?: PackageManager;
  name?: string;
  yes?: boolean;
  /** Install the optional agent skills (set to false via `--no-skills` to skip). */
  skills?: boolean;
  /** Create a new project from a starter template. */
  starter?: boolean;
  /** Apple Developer Team ID for a new iOS or macOS starter. */
  teamId?: string;
  /** Link to a specific Clerk application by ID (skips the interactive picker). */
  app?: string;
  /** Force accountless setup (auto-generated dev keys, no login). */
  accountless?: boolean;
  /** Deprecated alias for `accountless`. */
  keyless?: boolean;
  /** Force the authenticated flow (log in and link a real app) instead of defaulting to accountless. */
  login?: boolean;
  /** Pre-configure the accountless application from a Clerk application template. */
  template?: KeylessTemplate;
  /** Replace an existing unclaimed accountless application instead of keeping it. */
  fresh?: boolean;
  /** Let an agent replace the link to a different application that `--app` would overwrite. */
  relink?: boolean;
  /**
   * Create a new Clerk application named after the app, once every check that could stop setup
   * has passed, so a stopped run never leaves an unused application behind.
   */
  createApp?: boolean;
};

export async function init(options: InitOptions = {}) {
  emailLookup = undefined;
  const cwd = process.cwd();
  const agent = isAgent();

  setTelemetryStage("flags");
  const optsAccountless = options.accountless === true || options.keyless === true;
  if (options.keyless) {
    log.warn("`--keyless` is deprecated. Use `--accountless` instead.");
  }
  await assertUsableFlags(options, agent, optsAccountless);

  // macOS apps use the iOS (Swift) setup; the value only picks which starter to create.
  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework === MACOS ? "ios" : options.framework) ?? undefined)
    : options.xcodeProject
      ? (lookupFramework("ios") ?? undefined)
      : undefined;
  // Before any bootstrap, so an unsupported flag never leaves a new project behind.
  if (frameworkOverride) assertFrameworkFlags(options, frameworkOverride);

  const appleFlags = APPLE_FLAGS.filter(([key]) => options[key] != null).map(([, flag]) => flag);
  // iOS and macOS have no accountless setup, so a native starter rejects these before writing.
  const accountlessFlags = [
    optsAccountless && "--accountless",
    options.template != null && "--template",
    options.fresh && "--fresh",
  ].filter((flag): flag is string => Boolean(flag));
  const appleStarter =
    options.starter === true && (options.framework === "ios" || options.framework === MACOS);
  // Before the link checks below, whose advice (--app, --create-app) these flags would contradict.
  if (appleStarter && accountlessFlags.length) rejectAccountlessApple(accountlessFlags);
  // In agent mode, implicitly enable --yes to skip all confirmation prompts.
  const overrides: BootstrapOverrides = {
    skipConfirm: options.yes || agent,
    pmOverride: options.pm,
    nameOverride: options.name,
    json: options.json,
    ...(accountlessFlags.length && { accountlessFlags }),
    ...((appleFlags.length || options.framework === MACOS) && {
      apple: {
        platform: options.framework === MACOS ? "macos" : undefined,
        bundleId: options.bundleId,
        teamId: options.teamId,
        signInWithApple: options.signInWithApple,
        flags: appleFlags,
      },
    }),
  };

  intro("Setting up Clerk");

  setTelemetryStage("detect");
  // Only an existing native Apple project supports these outside a new starter, so they
  // skip project creation instead of being rejected after it.
  const existingProjectFlags = [
    options.dryRun && "--dry-run",
    options.json && !options.starter && "--json",
    ...(options.starter ? [] : appleFlags),
  ].filter((flag): flag is string => Boolean(flag));
  // A new app inside a repository linked elsewhere would move the whole repository's link, so an
  // agent hears about it before anything is written.
  if (options.starter && (options.createApp || (agent && options.app)))
    await assertLinkKept(cwd, options, { newProject: true });
  else if (appleStarter && agent) await assertApplicationChosen(cwd, options);
  let resolved: ResolvedContext | undefined;
  try {
    resolved = existingProjectFlags.length
      ? await resolveExistingProjectContext(cwd, frameworkOverride, overrides, existingProjectFlags)
      : options.starter
        ? await handleStarter(cwd, frameworkOverride, overrides)
        : await resolveProjectContext(cwd, frameworkOverride, overrides);
  } catch (error) {
    if (options.json && error instanceof StarterInputRequired)
      log.data(
        JSON.stringify({
          status: "input-required",
          appIntegrationComplete: false,
          starter: error.describe(),
        }),
      );
    throw error;
  }

  if (!resolved) return;

  const { ctx, bootstrap } = resolved;

  if (bootstrap) {
    ctx.isBootstrap = true;
  }

  assertFrameworkFlags(options, ctx.framework);
  const appleOptions: AppleInitOptions = {
    ...options,
    root: ctx.cwd,
    agent,
    ...(bootstrap?.apple && starterAppleOptions(options, bootstrap)),
  };
  const newApp = appleOptions.starterProject;
  // A new app's guidance and its JSON statuses name the same command.
  if (ctx.framework.dep === "ios")
    ctx.nativeContinuation = newApp?.continuation ?? appleContinuation(options);
  // Only native Apple supports a dry run today; it inspects without signing in.
  if (options.dryRun) return withNativeProgress(async () => runAppleInit(appleOptions, undefined));

  await enrichProjectContext(ctx);

  // Skip auth-related I/O entirely when the user opted into accountless setup — those
  // values are not consumed once the strategy resolves to "keyless".
  //
  // Agent mode has no way to recover if this lies: a human who turns out to be
  // unauthenticated just gets prompted to log in, but an agent that trusts a
  // stale/broken credential ends up blocked on an interactive browser OAuth
  // round-trip it can never complete. So agent mode validates the credential
  // (it can fall back to keyless) instead of trusting mere presence.
  setTelemetryStage("strategy");
  const authed = optsAccountless
    ? false
    : agent
      ? await isAuthenticatedForAgent()
      : await isAuthenticated();
  const linkedProfile =
    !optsAccountless && agent && !options.app && !options.createApp
      ? await resolveProfile(ctx.cwd)
      : undefined;
  const hasRealAppTarget = Boolean(options.app || options.createApp || linkedProfile);

  const strategy = pickStrategy({
    optsAccountless,
    optsLogin: options.login === true,
    agent,
    authed,
    isBootstrap: bootstrap != null,
    hasRealAppTarget,
    framework: ctx.framework,
  });

  assertKeylessOnlyFlags(options, strategy, Boolean(ctx.framework.supportsKeyless));

  if (strategy === "authenticate") {
    setTelemetryStage("link");
    bar();
    // The name an agent's missing application, or --create-app's new one, is given.
    const appName =
      agent || options.createApp
        ? await deriveProjectName(ctx.cwd, bootstrap?.projectName)
        : undefined;
    const createIfMissing = agent ? appName : undefined;
    // A project init generated without --starter (a blank directory) had no check before it was
    // written, so it's checked now, as itself. A --starter app was checked before writing.
    if (!options.starter && (options.createApp || (agent && options.app)))
      await assertLinkKept(ctx.cwd, options);
    let createdAppId: string | undefined;
    try {
      // The Xcode target, whether its team allows the requested features, and the new
      // application's native identity are settled before --create-app makes an application
      // that a stopped setup would leave unused.
      if (options.createApp && ctx.framework.dep === "ios" && canSetUpXcode()) {
        appleOptions.inspection = (
          await inspectAppleProject(appleOptions, {}, { newApplication: true })
        ).inspection;
      }
      await authenticateAndLink(
        ctx.cwd,
        options.app,
        createIfMissing,
        // Native setup continues right after linking, so link's `clerk env pull` advice doesn't apply.
        ctx.framework.dep === "ios" && canSetUpXcode() ? { showNextSteps: false } : {},
        options.createApp && appName
          ? {
              name: appName,
              // From here on, finishing the new app must link the application just created,
              // not create another.
              onCreate: (appId) => {
                createdAppId = appId;
                if (newApp && bootstrap?.apple)
                  newApp.continuation = appleContinuation(options, bootstrap, appId);
              },
            }
          : undefined,
      );
    } catch (error) {
      // A target to choose or an identity to supply already printed its own status.
      // A deliberate "no" isn't an interruption either.
      const reported =
        error instanceof SelectionNeeded ||
        error instanceof IdentityRequired ||
        error instanceof UserAbortError;
      // The new app is already on disk; say where, and how to finish it, instead of only failing.
      if (options.json && newApp && !reported)
        log.data(JSON.stringify(setupInterrupted(newApp, error, createdAppId), null, 2));
      // An application created for an existing project must be reused, not created again.
      else if (options.json && createdAppId && !reported && ctx.framework.dep === "ios")
        log.data(
          JSON.stringify(
            applicationInterrupted(
              createdAppId,
              appleContinuation(options, undefined, createdAppId),
              error,
            ),
            null,
            2,
          ),
        );
      throw error;
    }
    // If setup fails from here, it names this application so it's reused, not created again.
    if (createdAppId)
      appleOptions.createdApplication = {
        appId: createdAppId,
        continuation: newApp?.continuation ?? appleContinuation(options, undefined, createdAppId),
      };
  }

  // Native Apple setup edits the Xcode project and registers the app instead of
  // scaffolding files and pulling keys into an env file.
  if (ctx.framework.dep === "ios" && strategy === "authenticate" && canSetUpXcode()) {
    const linked = await resolveProfile(ctx.cwd);
    if (!linked)
      throw new CliError("Link a Clerk application before native setup.", {
        code: ERROR_CODE.NOT_LINKED,
      });
    return withNativeProgress(async () => runAppleInit(appleOptions, linked.profile.appId));
  }
  // An agent that asked for JSON gets the usual "choose an app" guidance as data.
  if (ctx.framework.dep === "ios" && strategy === "manual" && options.json) {
    log.data(JSON.stringify(applicationRequired(ctx.nativeContinuation, newApp), null, 2));
    setTelemetryStage("done");
    return;
  }

  // Short-circuit on a fully-clean re-run so env pull / skills prompt don't
  // execute when there's nothing to do.
  // Bootstrap implies consent — the user already opted into project creation, so
  // skip the scaffold "Proceed?" prompt as well.
  const skipScaffoldConfirm = overrides.skipConfirm || bootstrap != null;
  const { alreadySetUp } = await detectAndInstall(ctx.cwd, ctx, skipScaffoldConfirm);

  if (alreadySetUp) {
    setTelemetryStage("already_set_up");
    log.success("\nClerk is already set up in this project.");
    if (agent && strategy === "manual") {
      printBootstrapManualSetupInfo(ctx);
    }
    await outro("Done");
    return;
  }

  setTelemetryStage("keys");
  bar();
  await runStrategy(strategy, ctx, {
    template: options.template,
    fresh: options.fresh === true,
    skipConfirm: overrides.skipConfirm,
  });

  // Native platforms (iOS/Android) have no npx/Node toolchain to run `skills add` with.
  if (options.skills !== false && isNpmFramework(ctx.framework)) {
    setTelemetryStage("skills");
    bar();
    await installSkills(ctx.cwd, ctx.framework.dep, ctx.packageManager, overrides.skipConfirm);
  }

  // Next steps print last so they stay on screen as the final thing the user sees.
  if (bootstrap) {
    bar();
    printBootstrapNextSteps(bootstrap, strategy === "keyless", options);
  }

  setTelemetryStage("done");
  await outro("Done");
}

/**
 * Rejects flag combinations that can't both be honoured, before anything is
 * bootstrapped on disk. `--accountless`, `--template`, and `--fresh` describe an
 * application the CLI creates; `--login` and `--app` describe one that
 * already exists.
 */
async function assertUsableFlags(
  options: InitOptions,
  agent: boolean,
  accountless: boolean,
): Promise<void> {
  if (accountless && options.login) {
    throwUsageError("--accountless and --login cannot be combined.");
  }
  if (options.relink && !options.app && !options.createApp) {
    throwUsageError(
      "--relink applies with --app or --create-app: it lets them replace a link to a different application.",
    );
  }
  if (accountless && options.app) {
    throwUsageError(
      "--accountless cannot be combined with --app. Drop --accountless to link the app, or drop --app to use temporary development keys.",
    );
  }
  // Agents are why --create-app exists: a person picks or creates an application interactively.
  if (options.createApp && !agent) {
    throwUsageError(
      "--create-app is for agent runs (--mode agent, or any --json starter). Without it, clerk init asks which application to use and offers to create one.",
    );
  }
  if (options.createApp && options.app) {
    throwUsageError(
      "--create-app and --app cannot be combined. Pass --app to use an existing application, or --create-app to create one.",
    );
  }
  if (options.createApp && (accountless || options.dryRun)) {
    throwUsageError(
      `--create-app creates a real Clerk application, so it can't be combined with ${accountless ? "--accountless" : "--dry-run"}.`,
    );
  }
  // A named framework is known now, so an unsupported one is named before signing in matters.
  if (
    options.createApp &&
    options.framework &&
    options.framework !== "ios" &&
    options.framework !== MACOS
  )
    throwUsageError(CREATE_APP_APPLE_ONLY);
  // Signing in is the one check an agent can't fix mid-run, so it comes before a starter is written.
  if (options.createApp && agent && !(await isAuthenticatedForAgent())) {
    throwUsageError(
      "--create-app needs a signed-in Clerk CLI. Ask the user to run `clerk auth login`, then re-run `clerk init`.",
      undefined,
      ERROR_CODE.AUTH_REQUIRED,
    );
  }
  if (options.template && options.login) {
    throwUsageError(
      "--template applies to accountless applications and cannot be combined with --login.",
    );
  }
  if (options.fresh && options.login) {
    throwUsageError(
      "--fresh applies to accountless applications and cannot be combined with --login.",
    );
  }
  if (options.starter && options.dryRun) {
    throwUsageError("--dry-run works on an existing project, not with --starter.");
  }
  // A web starter's generator writes to the terminal, so only a native one can report JSON.
  if (
    options.starter &&
    options.json &&
    options.framework !== "ios" &&
    options.framework !== MACOS
  ) {
    throwUsageError(
      "--json works with --starter only for a new iOS or macOS app: add --framework ios or --framework macos.",
    );
  }
  if (options.dryRun && (options.app || accountless || options.login)) {
    throwUsageError(
      "--dry-run never signs in or changes your Clerk application; drop --app, --login, and --accountless.",
    );
  }
  const xcodeSelection = [
    options.xcodeProject != null && "--xcode-project",
    options.xcodeTarget != null && "--xcode-target",
    options.xcodeConfiguration != null && "--xcode-configuration",
  ].filter(Boolean);
  if (options.starter && xcodeSelection.length) {
    throwUsageError(
      `${xcodeSelection.join(", ")} ${xcodeSelection.length === 1 ? "selects" : "select"} an existing Xcode project and can't be combined with --starter.`,
    );
  }
  if (options.teamId != null && !options.starter) {
    throwUsageError(
      "--team-id applies to a new app with --starter. For an existing app, set the team in Xcode, or pass --app-id-prefix.",
    );
  }
  if (options.appIdPrefix != null && !/^[A-Z0-9]{10}$/.test(options.appIdPrefix.trim())) {
    throwUsageError("--app-id-prefix must be the 10-character App ID Prefix from Apple Developer.");
  }
  if (options.appleSdk === "core" && options.prebuiltAuthUi) {
    throwUsageError("--prebuilt-auth-ui needs ClerkKitUI; use --apple-sdk ui or omit --apple-sdk.");
  }
  // Presence-only here would repeat the hang below: an agent can't complete an
  // interactive login, so a stored-but-broken credential must read as
  // unauthenticated rather than let this guard wave the request through.
  if (options.login && agent && !(await isAuthenticatedForAgent())) {
    throwUsageError(
      "--login requires an interactive terminal to complete the browser login. Ask the user to run `clerk auth login`, then re-run `clerk init`.",
    );
  }
}

const APPLE_FLAGS = [
  ["xcodeProject", "--xcode-project"],
  ["xcodeTarget", "--xcode-target"],
  ["xcodeConfiguration", "--xcode-configuration"],
  ["appleSdk", "--apple-sdk"],
  ["bundleId", "--bundle-id"],
  ["appIdPrefix", "--app-id-prefix"],
  ["teamId", "--team-id"],
  ["signInWithApple", "--sign-in-with-apple"],
  ["prebuiltAuthUi", "--prebuilt-auth-ui"],
] as const;

/** `--framework macos` creates a macOS starter; for an existing app it means the iOS (Swift) setup. */
const MACOS = "macos";

/**
 * A new starter already settled its identity: setup reads the Bundle ID back from the project it
 * wrote, registers it with the starter's team as the App ID Prefix instead of asking again, and
 * skips the confirmation that protects existing projects.
 */
/** The identity setup uses for a new starter, and the continuation that finishes it carries. */
function starterIdentity(options: InitOptions, apple: AppleStarter) {
  return {
    // The project already carries `--bundle-id`; passing it again would mask what Xcode reports.
    bundleId: undefined,
    appIdPrefix: options.appIdPrefix ?? apple.teamId,
  };
}

function starterAppleOptions(
  options: InitOptions,
  starter: { projectDir: string; projectName: string; apple: AppleStarter },
): Partial<AppleInitOptions> & { starterProject: StarterProjectSummary } {
  return {
    ...starterIdentity(options, starter.apple),
    starterProject: {
      projectName: starter.projectName,
      platform: starter.apple.platform,
      projectDir: starter.projectDir,
      continuation: appleContinuation(options, starter, options.app),
    },
  };
}

/**
 * The `clerk init` an agent runs once it has chosen an application, carrying this run's native
 * setup options so the next run doesn't fall back to defaults. After a new starter it runs inside
 * the new app, so it starts with `cd`: the project already holds the Bundle ID and team, so their
 * flags are dropped, and the starter's own decisions are carried.
 */
function appleContinuation(
  options: InitOptions,
  starter?: { projectName: string; apple: AppleStarter },
  appId?: string,
): string {
  const values: Partial<InitOptions> = {
    ...options,
    ...(starter && starterIdentity(options, starter.apple)),
  };
  const parts = [
    ...(starter ? [`cd ${quoteArg(starter.projectName)}`, "&&"] : []),
    `clerk init ${appId ? `--app ${quoteArg(appId)}` : options.createApp ? "--create-app" : "--app <app_id>"} --json`,
    ...(options.relink ? ["--relink"] : []),
  ];
  for (const [key, flag] of APPLE_FLAGS) {
    if (key === "teamId" || (starter && key === "bundleId")) continue;
    const value = values[key];
    if (value === true) parts.push(flag);
    else if (typeof value === "string" && value) parts.push(flag, quoteArg(value));
  }
  return parts.join(" ");
}

/** A link decision the user must make, already printed as an `input-required` status with `--json`. */
class LinkDecisionRequired extends CliError {
  constructor(message: string) {
    super(message, { code: ERROR_CODE.USAGE_ERROR, exitCode: EXIT_CODE.USAGE });
  }
}

/**
 * In agent mode, `--app` naming a different application than this folder's link would silently
 * replace it, and inside a Git repository that link is shared by every project there. Without
 * `--relink`, stop and say so instead; with `--json`, also as an `input-required` status.
 * `--create-app` (agent runs only) is checked before the application exists.
 */
async function assertLinkKept(
  cwd: string,
  options: InitOptions,
  { newProject = false }: { newProject?: boolean } = {},
): Promise<void> {
  if ((!options.app && !options.createApp) || options.relink) return;
  const replaced = await replacedLink(cwd, options.app, { newProject });
  if (!replaced) return;
  const current = replaced.appName ? `${replaced.appName} (${replaced.appId})` : replaced.appId;
  const target = options.app ?? "a new application";
  // Sharing the linked application is usually right for an app in the same product's repository.
  const keep = newProject
    ? `pass --app ${replaced.appId} to share its application, or create the new app outside this repository`
    : options.app
      ? `or pass --app ${replaced.appId} to keep the current link`
      : `or pass --app ${replaced.appId} instead of --create-app to keep the current link`;
  const subject = newProject ? "a new app here" : "it";
  const change = options.app
    ? `Linking ${subject} to ${options.app} switches every Clerk CLI command in ${replaced.scope} to ${options.app}`
    : `Linking ${subject} to a new Clerk application switches every Clerk CLI command in ${replaced.scope} to that application`;
  const message = `${replaced.scope} is linked to ${current}. ${change}. Rerun with --relink to switch it, ${keep}.`;
  if (options.json)
    log.data(
      JSON.stringify({
        status: "input-required",
        appIntegrationComplete: false,
        link: {
          flag: "--relink",
          question: `Switch the Clerk CLI link for ${replaced.scope} from ${current} to ${target}?`,
          issue: message,
          current: {
            appId: replaced.appId,
            ...(replaced.appName && { appName: replaced.appName }),
          },
          ...(options.app ? { requested: options.app } : { createApp: true }),
          scope: replaced.scope,
        },
      }),
    );
  throw new LinkDecisionRequired(message);
}

/**
 * A new app made here would otherwise set itself up against whatever link covers this directory,
 * a parent's or the repository's, which may belong to another project. An agent names the
 * application instead: `--app` with the linked one to share it, or another, or `--create-app`.
 */
async function assertApplicationChosen(cwd: string, options: InitOptions): Promise<void> {
  const inherited = await resolveProfile(cwd);
  if (!inherited) return;
  const { appId, appName } = inherited.profile;
  const current = appName ? `${appName} (${appId})` : appId;
  const scope = (await getGitRepoRoot(cwd)) ?? inherited.path;
  const message = `${scope} is linked to ${current}, so a new app here would use it too. Choose the new app's application: pass --app ${appId} to share it, --app with another application, or --create-app to create one.`;
  if (options.json)
    log.data(
      JSON.stringify({
        status: "input-required",
        appIntegrationComplete: false,
        link: {
          flag: "--app",
          question: `Should the new app use ${current}, another application, or a new one?`,
          issue: message,
          current: { appId, ...(appName && { appName }) },
          scope,
        },
      }),
    );
  throw new LinkDecisionRequired(message);
}

/** Rejects flags the detected (or requested) framework can't honour. */
const CREATE_APP_APPLE_ONLY =
  "--create-app applies only to iOS and macOS apps. For other frameworks, an agent run already creates an application named after the project when none is linked.";

function assertFrameworkFlags(options: InitOptions, framework: FrameworkInfo): void {
  if (options.createApp && framework.dep !== "ios") throwUsageError(CREATE_APP_APPLE_ONLY);
  if (options.dryRun && !framework.supportsDryRun)
    throwUsageError(`--dry-run isn't supported for ${framework.name} yet.`);
  if (options.json && !framework.supportsJson)
    throwUsageError(`--json isn't supported for ${framework.name} yet.`);
  const apple = APPLE_FLAGS.filter(([key]) => options[key] != null).map(([, flag]) => flag);
  const needsXcode = [options.dryRun && "--dry-run", options.json && "--json", ...apple].filter(
    Boolean,
  );
  // A new starter stops before writing with its own "needs Xcode on macOS" error.
  if (framework.dep === "ios" && !canSetUpXcode() && needsXcode.length && !options.starter)
    throwUsageError(
      `${needsXcode.join(", ")} ${needsXcode.length === 1 ? "needs" : "need"} Xcode on macOS. Without them, clerk init links your app and prints the setup steps.`,
    );
  if (apple.length && framework.dep !== "ios")
    throwUsageError(
      `${apple.join(", ")} ${apple.length === 1 ? "applies" : "apply"} only to iOS (Swift) projects.`,
    );
}

/**
 * Agent-mode variant of `isAuthenticated()`. The human-mode presence check
 * (see `heuristics.isAuthenticated`) deliberately doesn't validate the
 * credential, because a human who turns out to be unauthenticated just gets
 * an interactive login prompt. An agent has no such fallback — if it trusts a
 * stale/broken credential, it ends up blocked on a browser OAuth round-trip
 * that can never complete. So this validates before trusting: a real API key
 * is accepted outright (no OAuth involved), everything else must actually
 * resolve to a user.
 */
async function isAuthenticatedForAgent(): Promise<boolean> {
  if (process.env.CLERK_PLATFORM_API_KEY) return true;
  return (await authenticatedEmail()) !== null;
}

// Several checks in one run ask who's signed in (the flag checks, the strategy, the sign-in
// label), and each answer is a network request, so a run asks once. `init` clears it per run.
let emailLookup: Promise<string | null> | undefined;
async function authenticatedEmail(): Promise<string | null> {
  emailLookup ??= getAuthenticatedEmail();
  return emailLookup;
}

/**
 * `--template` and `--fresh` only take effect when init creates an accountless
 * application. Silently dropping them when the strategy resolves elsewhere
 * (the pre-fix behaviour for `--template`) leaves the user believing they got
 * a shaped or replaced app when they didn't — so fail loudly instead, the
 * same way `--accountless`+`--app` does above. This runs after strategy
 * resolution because that's the earliest point the real strategy — not just
 * the flags that might influence it — is known.
 */
function assertKeylessOnlyFlags(
  options: InitOptions,
  strategy: InitStrategy,
  supportsAccountless: boolean,
): void {
  if (strategy === "keyless") return;

  // "Add --accountless" is only valid remediation when accountless setup is
  // actually reachable from here — not when the framework doesn't support it
  // or when --app/--login are what forced the authenticated flow (both
  // conflict with --accountless in assertUsableFlags above). Framework
  // support is checked directly, not via strategy: an unsupported framework
  // resolves to "manual" only in agent mode — in human mode it resolves to
  // "authenticate", which would otherwise suggest an --accountless flag the
  // framework rejects.
  let reason: string;
  // Null when dropping the offending flag is the only remediation.
  let remedy: string | null;
  if (!supportsAccountless) {
    reason = "this framework does not support accountless setup";
    remedy = null;
  } else if (options.app) {
    reason = "--app was set, which cannot be combined with --accountless";
    remedy = "drop --app to allow accountless setup";
  } else if (options.login) {
    reason = "--login was set, which cannot be combined with --accountless";
    remedy = "drop --login to allow accountless setup";
  } else {
    reason =
      "this run resolved to the authenticated flow instead (already signed in, or a project is already linked)";
    remedy = "add --accountless to force an accountless app";
  }

  const tail = (flag: string): string => (remedy ? `${remedy}, or drop ${flag}.` : `drop ${flag}.`);
  if (options.template) {
    throwUsageError(
      `--template only applies to accountless applications, but ${reason}; ${tail("--template")}`,
    );
  }
  if (options.fresh) {
    throwUsageError(
      `--fresh only applies to accountless applications, but ${reason}; ${tail("--fresh")}`,
    );
  }
}

type ResolvedContext = {
  ctx: ProjectContext;
  bootstrap: BootstrapResult | null;
};

// --- Bootstrap paths ---

async function bootstrapAndDetect(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
): Promise<ResolvedContext> {
  setTelemetryStage("bootstrap");
  const bootstrap = await promptAndBootstrap(cwd, frameworkOverride, overrides);

  const ctx = await gatherContext(bootstrap.projectDir);
  if (!ctx) {
    throw new CliError("Project generation did not produce a detectable framework.", {
      code: ERROR_CODE.FRAMEWORK_UNDETECTED,
    });
  }
  return { ctx, bootstrap };
}

async function handleStarter(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
): Promise<ResolvedContext> {
  setTelemetryStage("bootstrap");
  if (!overrides.skipConfirm) {
    await confirmOverwrite(cwd);
  }

  return bootstrapAndDetect(cwd, frameworkOverride, {
    ...overrides,
    implicitBootstrap: true,
  });
}

async function resolveProjectContext(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
): Promise<ResolvedContext> {
  // When --framework is provided, gatherContext will always return a truthy
  // context because the override skips detectFramework. Guard against this in
  // blank directories so the bootstrap path (e.g. create-next-app) still runs.
  // Native platforms (iOS/Android) never have a package.json — a missing one
  // does not mean a blank directory, so they skip the bootstrap shortcut.
  if (frameworkOverride && isNpmFramework(frameworkOverride) && !(await hasPackageJson(cwd))) {
    return bootstrapAndDetect(cwd, frameworkOverride, overrides);
  }

  const ctx = await withSpinner("Detecting framework...", async () =>
    gatherContext(cwd, frameworkOverride, overrides.pmOverride),
  );
  if (ctx) return { ctx, bootstrap: null };

  const isBlank = !(await hasPackageJson(cwd));

  if (!isBlank) {
    throw new CliError(
      `Could not detect a framework. Install the appropriate Clerk SDK manually: https://clerk.com/docs`,
      { code: ERROR_CODE.FRAMEWORK_UNDETECTED },
    );
  }

  return bootstrapAndDetect(cwd, frameworkOverride, overrides);
}

/** A dry run inspects what's here; it never bootstraps a new project. */
async function resolveExistingProjectContext(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
  flags: readonly string[],
): Promise<ResolvedContext> {
  const ctx = await withSpinner("Detecting framework...", async () =>
    gatherContext(cwd, frameworkOverride, overrides.pmOverride),
  );
  if (!ctx)
    throw new CliError(
      `${flags.join(", ")} ${flags.length === 1 ? "needs" : "need"} an existing project, and none was detected here.`,
      { code: ERROR_CODE.FRAMEWORK_UNDETECTED },
    );
  return { ctx, bootstrap: null };
}

// --- Next steps ---

function devCommand(pm: string): string {
  return pm === "npm" ? "npm run dev" : `${pm} dev`;
}

function printBootstrapNextSteps(
  bootstrap: BootstrapResult,
  accountless: boolean,
  options: InitOptions,
): void {
  // Reached for a native starter only when an agent hasn't chosen a Clerk application yet. The
  // agent must finish setup from inside the new app, so it gets the steps too.
  if (bootstrap.apple) {
    const steps = [appleContinuation(options, bootstrap)];
    printNextSteps(steps);
    printAgentNextSteps(steps);
    return;
  }
  const { projectName, packageManager } = bootstrap;
  const steps = [`cd ${projectName}`, devCommand(packageManager)];
  if (accountless) {
    steps.push("clerk auth login  (when you're ready to connect your Clerk account)");
  }
  printNextSteps(steps);
}

function printBootstrapManualSetupInfo(ctx: ProjectContext): void {
  const { framework } = ctx;
  // Only reachable for frameworks without accountless support: capable ones resolve to
  // the "keyless" or "authenticate" strategy in agent mode instead.
  const native = framework.dep === "ios" && canSetUpXcode() && ctx.nativeContinuation;
  const lines = [
    `\n  Set up Clerk for ${framework.name}:`,
    `    ${framework.name} requires API keys — set them up manually:`,
    `    ${native || "clerk init --app <app_id>"}`,
    // Swift apps configure the key in source; there's no env file to pull into.
    ...(framework.dep === "ios" && canSetUpXcode() ? [] : ["    clerk env pull"]),
  ];
  log.info(lines.map(dim).join("\n"));
}

// --- Strategy ---

type InitStrategy = "keyless" | "manual" | "authenticate";

// Picks how `clerk init` will reach a working Clerk setup:
// - "keyless"      → temporary development keys, no login. Forced via `--accountless`, or the default
//                    for unauthenticated runs on a keyless-capable framework (human bootstrap and
//                    all agent runs). A legacy `.clerk/keyless.json` breadcrumb lets the next
//                    `clerk auth login` claim the app automatically.
// - "manual"       → agent mode on a non-keyless framework without a real app target — scaffold
//                    locally and print guidance instead of running OAuth.
// - "authenticate" → log in (interactively if needed) and link a real Clerk application. Forced
//                    via `--login`, and the default whenever accountless setup doesn't apply.
function pickStrategy({
  optsAccountless,
  optsLogin,
  agent,
  authed,
  isBootstrap,
  hasRealAppTarget,
  framework,
}: {
  optsAccountless: boolean;
  optsLogin: boolean;
  agent: boolean;
  authed: boolean;
  isBootstrap: boolean;
  hasRealAppTarget: boolean;
  framework: FrameworkInfo;
}): InitStrategy {
  if (optsAccountless) {
    if (!framework.supportsKeyless) {
      throwUsageError(
        `--accountless is not supported for ${framework.name}. Run \`clerk auth login\` and use \`clerk init --app <app_id>\` instead.`,
      );
    }
    return "keyless";
  }
  if (optsLogin || hasRealAppTarget) return "authenticate";
  if (agent && !framework.supportsKeyless) return "manual";
  if (!authed && framework.supportsKeyless && (agent || isBootstrap)) return "keyless";
  return "authenticate";
}

type KeylessRunOptions = {
  template?: KeylessTemplate;
  /** Escape hatch for "give me a fresh one": mint a new app even if an unclaimed one already exists. */
  fresh: boolean;
  /** Agent mode and `-y` both skip y/n prompts, so both must default to *not* replacing. */
  skipConfirm: boolean;
};

async function runStrategy(
  strategy: InitStrategy,
  ctx: ProjectContext,
  keylessOptions: KeylessRunOptions,
): Promise<void> {
  switch (strategy) {
    case "manual":
      printBootstrapManualSetupInfo(ctx);
      return;
    case "authenticate":
      await pull({ file: ctx.envFile, cwd: ctx.cwd });
      return;
    case "keyless":
      await setupKeylessApp(ctx.cwd, ctx.framework.dep, ctx.envFile, keylessOptions);
      return;
  }
}

// --- Auth ---

async function resolveAuthLabel(): Promise<string> {
  const hasApiKey = Boolean(process.env.CLERK_PLATFORM_API_KEY);
  if (hasApiKey) return "Using API key";

  const email = await authenticatedEmail();
  if (email) return `Logged in as ${email}`;

  await login({ showNextSteps: false });
  return "";
}

async function authenticateAndLink(
  cwd: string,
  app: string | undefined,
  createIfMissing: string | undefined,
  linkOptions: { showNextSteps?: false } = {},
  createApp?: { name: string; onCreate(appId: string): void },
): Promise<void> {
  const label = await resolveAuthLabel();
  if (createApp) {
    if (label) log.info(dim(label));
    const created = await withApiContext(
      createApplication(createApp.name),
      "Failed to create application",
    );
    createApp.onCreate(created.application_id);
    log.success(`Created ${created.name || created.application_id}`);
    try {
      // assertLinkKept already settled any link this replaces.
      await link({
        app: created.application_id,
        application: created,
        cwd,
        confirmedRelink: true,
        ...linkOptions,
      });
    } catch (error) {
      // Rerunning with --create-app would make a second application; name the one to reuse. The
      // error itself is rethrown as it is, so a cancel or a sign-in failure keeps its handling.
      log.warn(
        `The application ${created.application_id} was created, but not linked. Rerun with --app ${created.application_id} instead of --create-app.`,
      );
      throw error;
    }
    return;
  }
  const profile = await resolveProfile(cwd);

  const alreadyOnRequestedApp = profile && (!app || profile.profile.appId === app);

  if (label && alreadyOnRequestedApp) {
    log.info(dim(`${label} · Linked to ${profile.profile.appId}`));
    return;
  }

  if (label) {
    log.info(dim(label));
  }

  await link({ skipIfLinked: true, app, cwd, createIfMissing, ...linkOptions });
}

// --- Keyless app setup ---

/**
 * A legacy `.clerk/keyless.json` breadcrumb means an earlier run already minted an
 * unclaimed accountless application for this project — its claim token, and the
 * local means of claiming or reaching it, only exist as long as that
 * breadcrumb (and the env keys pointing at it) survive. The same is true of
 * an application a Clerk SDK minted for itself in `.clerk/.tmp/keyless.json`
 * (running `next dev` with no keys configured), so both files count as "an
 * app already exists here". Re-running init must not silently mint a
 * replacement and orphan either one, so this asks before ever touching it:
 * human mode confirms (default: keep); agent mode and `-y` both keep it too,
 * since neither can consent to a destructive default. `--fresh` is the
 * explicit "I know, replace it anyway" escape hatch.
 */
async function shouldKeepExistingKeyless(
  cwd: string,
  skipConfirm: boolean,
  fresh: boolean,
): Promise<boolean> {
  if (fresh) return false;

  const existing = await readKeylessBreadcrumb(cwd);
  const sdkApp = existing ? undefined : await readSdkKeylessApp(cwd);
  if (!existing && !sdkApp?.secretKey) return false;

  if (skipConfirm) return true;

  const replace = await confirm({
    message: existing
      ? `This project already has an unclaimed accountless application (created ${existing.createdAt}). Replace it with a new one?`
      : "This project already has an unclaimed accountless application (minted by its Clerk SDK in `.clerk/.tmp/keyless.json`). Replace it with a new one?",
    default: false,
  });
  return !replace;
}

async function setupKeylessApp(
  cwd: string,
  frameworkDep: string,
  envFile: string,
  { template, fresh, skipConfirm }: KeylessRunOptions,
): Promise<void> {
  if (await shouldKeepExistingKeyless(cwd, skipConfirm, fresh)) {
    printExistingKeylessInfo(envFile);
    return;
  }

  try {
    const app = await withSpinner(
      template
        ? `Creating development application (${template})...`
        : "Creating development application...",
      async () => createAccountlessApp(frameworkDep, template),
    );

    await writeKeysToEnvFile(cwd, {
      publishableKey: app.publishable_key,
      secretKey: app.secret_key,
    });

    await writeKeylessBreadcrumb(cwd, parseClaimToken(app.claim_url));
    printKeylessInfo(envFile);
  } catch (error) {
    log.debug(`Could not create accountless app: ${errorMessage(error)}`);
    // Ctrl-C aborts the in-flight request, so an interrupt arrives here as an
    // `AbortError` indistinguishable from the 15s timeout. Swallowing it would
    // blame the network and carry on with the rest of init; rethrow so the
    // interrupt keeps its exit code and stops the run.
    if (interruptedExitCode() !== null) throw error;
    const isTimeout = error instanceof Error && error.name === "AbortError";
    const prefix = isTimeout
      ? "Could not reach api.clerk.com within 15s."
      : "Could not set up development keys.";
    log.warn(
      `${prefix} Run \`clerk auth login\` then \`clerk link\` to connect your app manually.`,
    );
  }
}

// --- Detect & install ---

async function detectAndInstall(
  cwd: string,
  ctx: ProjectContext,
  skipConfirm: boolean,
): Promise<{ alreadySetUp: boolean }> {
  const variantLabel = ctx.variant ? ` (${ctx.variant})` : "";
  log.info(`\nDetected ${bold(ctx.framework.name)}${variantLabel}`);

  detectAuthLibraries(ctx.deps);
  log.blank();

  if (ctx.existingClerk) {
    log.info(dim(`${ctx.framework.sdk} is already installed`));
  } else if (isNpmFramework(ctx.framework)) {
    setTelemetryStage("install");
    await installSdk(ctx);
  }
  // Non-npm ecosystems (Swift Package Manager, Gradle) can't be installed by a
  // package manager here — the framework's scaffold plan prints install steps.

  setTelemetryStage("scaffold");
  return scaffoldAndWrite(cwd, ctx, skipConfirm);
}

async function scaffoldAndWrite(
  cwd: string,
  ctx: ProjectContext,
  skipConfirm: boolean,
): Promise<{ alreadySetUp: boolean }> {
  const plan = await scaffold(ctx);
  const hasChanges = plan.actions.some((a) => a.type !== "skip");

  // Fully-clean re-run: signal to init() to skip env pull / skills install.
  if (!hasChanges && plan.postInstructions.length === 0) {
    return { alreadySetUp: true };
  }

  if (!hasChanges) {
    log.info(dim("\nNo files to scaffold, but:"));
    for (const instr of plan.postInstructions) {
      log.info(dim(`  • ${instr}`));
    }
    return { alreadySetUp: false };
  }

  if (await checkGitDirty(cwd)) {
    log.warn("You have uncommitted changes");
    log.info(dim("Consider committing first so you can review what clerk init creates.\n"));
  }

  if (skipConfirm) {
    previewPlan(plan);
  } else {
    const proceed = await previewAndConfirm(plan);
    if (!proceed) throwUserAbort();
  }

  if (plan.additionalDeps?.length) {
    await installDeps(ctx, plan.additionalDeps);
  }

  const writtenFiles = await writePlan(cwd, plan);
  await runFormatters(ctx, writtenFiles);

  const findings = await withSpinner("Scanning for issues...", async () =>
    scanForIssues(cwd, ctx.framework.dep),
  );
  printOutro(plan, findings);

  return { alreadySetUp: false };
}

export function registerInit(program: Program): void {
  program
    .command("init")
    .description("Initialize Clerk in your project")
    .addOption(
      createOption("--framework <name>", "Framework to set up (skips auto-detection)").choices([
        ...FRAMEWORK_NAMES,
        MACOS,
      ]),
    )
    .addOption(
      createOption(
        "--pm <manager>",
        "Package manager to use (skips prompt/auto-detection)",
      ).choices(PACKAGE_MANAGERS),
    )
    .option("--name <project-name>", "Project name for --starter (skips prompt)")
    .option("--app <id>", "Application ID to link (skips interactive picker)")
    .option("--starter", "Create a new project from a starter template")
    .option(
      "--accountless",
      "Force accountless development keys, even when logged in (only for supported frameworks)",
    )
    .addOption(createOption("--keyless", "Deprecated alias for --accountless").hideHelp())
    .option(
      "--login",
      "Force the authenticated flow: log in and link a real application instead of accountless keys",
    )
    .addOption(
      createOption(
        "--template <name>",
        "Pre-configure the accountless application from a Clerk application template. Only applies when the strategy resolves to accountless — errors otherwise",
      ).choices(KEYLESS_TEMPLATES),
    )
    .option(
      "--fresh",
      "Replace an existing unclaimed accountless application with a new one, instead of keeping it. Only applies when the strategy resolves to accountless — errors otherwise",
    )
    .option(
      "--dry-run",
      "Inspect the project and print the setup plan without changing anything (iOS only)",
    )
    .option("--json", "Print the setup result as JSON (iOS only)")
    .option("--xcode-project <path>", "Xcode project or workspace to set up")
    .option("--xcode-target <name-or-id>", "Xcode app target to set up, by name or ID")
    .option("--xcode-configuration <name>", "Xcode build configuration to inspect")
    .addOption(
      createOption(
        "--apple-sdk <products>",
        "Clerk SDK products: core (ClerkKit) or ui (ClerkKit + ClerkKitUI)",
      ).choices(["core", "ui"]),
    )
    .option(
      "--bundle-id <id>",
      "Bundle ID for a new iOS or macOS app with --starter, or to register when Xcode's is ambiguous",
    )
    .option("--app-id-prefix <prefix>", "10-character Apple App ID Prefix for a new registration")
    .option(
      "--team-id <id>",
      "Apple Developer Team ID for a new iOS or macOS app with --starter (skips the team prompt)",
    )
    .option("--sign-in-with-apple", "Enable native Sign in with Apple")
    .option(
      "--prebuilt-auth-ui",
      "Add ClerkKitUI's prebuilt sign-in screen to an unchanged SwiftUI starter",
    )
    .option(
      "--create-app",
      "Create a new Clerk application named after the app, once setup's checks pass",
    )
    .option(
      "--relink",
      "Let --app or --create-app replace this folder's link to a different application",
    )
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--no-skills", "Skip the optional agent skills install prompt")
    .setExamples([
      { command: "clerk init", description: "Auto-detect framework and set up Clerk" },
      {
        command: "clerk init --framework next",
        description: "Set up for Next.js (skips detection)",
      },
      {
        command: "clerk init --app app_123",
        description: "Link to a specific Clerk application",
      },
      { command: "clerk init --starter", description: "Create a new project with Clerk" },
      {
        command: "clerk init --starter --framework next --pm bun",
        description: "Bootstrap with Bun",
      },
      {
        command: "clerk init --starter --framework next --accountless",
        description: "Bootstrap with temporary dev keys, even when logged in",
      },
      {
        command: "clerk init --starter --framework ios",
        description: "Create a SwiftUI iOS app in Xcode and set up Clerk",
      },
      {
        command: "clerk init --login",
        description: "Log in and link a real application instead of accountless keys",
      },
      {
        command: "clerk init --template b2b-saas",
        description: "Bootstrap an accountless app pre-configured for B2B SaaS",
      },
      {
        command: "clerk init --accountless --fresh",
        description: "Replace an existing unclaimed accountless app with a new one",
      },
      {
        command: "clerk init --dry-run --json",
        description: "Inspect an Xcode project and print its setup plan as JSON",
      },
      { command: "clerk init -y", description: "Skip all confirmation prompts" },
      { command: "clerk init --no-skills", description: "Skip the agent skills install prompt" },
    ])
    // A --json starter is read by a program, and agent mode is how every prompt in init (sign-in,
    // the app picker, relinking, the starter's questions) knows to stand down, with an
    // input-required or application-required status instead. An explicit --mode still wins.
    .hook("preAction", (_command, actionCommand) => {
      const opts = actionCommand.optsWithGlobals();
      if (opts.starter && opts.json && !opts.mode) setMode("agent");
    })
    .action(init);
}
