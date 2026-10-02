import { createOption } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { login } from "../auth/login.js";
import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { isAgent } from "../../mode.js";
import { dim, bold } from "../../lib/color.js";
import {
  throwUserAbort,
  throwUsageError,
  CliError,
  ERROR_CODE,
  errorMessage,
} from "../../lib/errors.js";
import {
  lookupFramework,
  isNpmFramework,
  FRAMEWORK_NAMES,
  type FrameworkInfo,
} from "../../lib/framework.js";
import { resolveProfile } from "../../lib/config.js";
import { deriveProjectName } from "../../lib/project-name.js";
import { log } from "../../lib/log.js";
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
import { printNextSteps } from "../../lib/next-steps.js";
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
  confirmOverwrite,
  type BootstrapOverrides,
  type BootstrapResult,
} from "./bootstrap.js";
import type { ProjectContext } from "./frameworks/types.js";
import { type PackageManager, PACKAGE_MANAGERS } from "../../lib/package-manager.ts";
import { withNativeSpinner, withNativeProgress } from "./ios/progress.ts";
import { runAppleInit } from "./ios/coordinator.ts";

export type InitOptions = {
  project?: string;
  configuration?: string;
  bundleId?: string;
  /** Framework to set up (skips auto-detection). */
  framework?: string;
  pm?: PackageManager;
  name?: string;
  yes?: boolean;
  /** Install the optional agent skills (set to false via `--no-skills` to skip). */
  skills?: boolean;
  /** Create a new project from a starter template. */
  starter?: boolean;
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
  /** Inspect a native Apple project and print the setup plan without changing local or remote state. */
  dryRun?: boolean;
  /** Emit native Apple setup results and the agent handoff as JSON. */
  json?: boolean;
  /** Native Apple application target name or PBX object ID. */
  target?: string;
  /** Allow native Apple setup to update a project file that already has local changes. */
  allowDirty?: boolean;
  /** Apple App ID Prefix used when a new Clerk native application registration is required. */
  appIdPrefix?: string;
  /** Opt into native Sign in with Apple setup for the selected native Apple target. */
  signInWithApple?: boolean;
  /** Opt into ClerkKitUI's prebuilt AuthView flow for a proven pristine SwiftUI target. */
  prebuiltAuthUI?: boolean;
  /** Native Apple SDK products; does not insert authentication UI. */
  sdk?: "core" | "ui";
  /** Commander's camel-case form of --prebuilt-auth-ui. Normalized at the command boundary. */
  prebuiltAuthUi?: boolean;
};

export async function init(options: InitOptions = {}) {
  if (options.prebuiltAuthUI == null && options.prebuiltAuthUi != null) {
    options = { ...options, prebuiltAuthUI: options.prebuiltAuthUi };
  }
  const cwd = process.cwd();
  const agent = isAgent() || options.json === true;
  const machineOutput = options.json === true || (options.dryRun === true && agent);

  setTelemetryStage("flags");
  const optsAccountless = options.accountless === true || options.keyless === true;
  if (options.keyless) {
    log.warn("`--keyless` is deprecated. Use `--accountless` instead.");
  }
  assertUsableFlags(options, optsAccountless);

  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework) ?? undefined)
    : options.project != null
      ? (lookupFramework("ios") ?? undefined)
      : undefined;
  const requiresExistingIOSProject =
    options.project != null ||
    options.configuration != null ||
    options.bundleId != null ||
    options.target != null ||
    options.allowDirty === true ||
    options.appIdPrefix != null ||
    options.signInWithApple === true ||
    options.prebuiltAuthUI === true ||
    options.sdk != null;
  if (requiresExistingIOSProject && frameworkOverride && frameworkOverride.dep !== "ios") {
    throwUsageError(
      "--project, --configuration, --target, --bundle-id, --app-id-prefix, --sign-in-with-apple, --prebuilt-auth-ui, and --sdk apply only to native Apple projects.",
    );
  }

  // In agent mode, implicitly enable --yes to skip all confirmation prompts.
  const overrides: BootstrapOverrides = {
    skipConfirm: options.yes || agent,
    pmOverride: options.pm,
    nameOverride: options.name,
  };

  if (!machineOutput) {
    intro(options.dryRun ? "Inspecting Clerk setup" : "Setting up Clerk");
  }

  setTelemetryStage("detect");
  const resolved = options.dryRun
    ? await resolveReadOnlyProjectContext(cwd, frameworkOverride, overrides, machineOutput)
    : requiresExistingIOSProject
      ? await resolveExistingProjectContext(cwd, frameworkOverride, overrides)
      : options.starter
        ? await handleStarter(cwd, frameworkOverride, overrides)
        : await resolveProjectContext(cwd, frameworkOverride, overrides);

  if (!resolved) return;

  const { ctx, bootstrap } = resolved;

  if (bootstrap) {
    ctx.isBootstrap = true;
  }

  if (
    !options.dryRun &&
    ctx.framework.dep !== "ios" &&
    (options.project ||
      options.configuration ||
      options.bundleId ||
      options.target ||
      options.allowDirty ||
      options.appIdPrefix ||
      options.signInWithApple ||
      options.prebuiltAuthUI ||
      options.sdk)
  ) {
    throwUsageError(
      "--project, --configuration, --target, --bundle-id, --app-id-prefix, --sign-in-with-apple, --prebuilt-auth-ui, and --sdk apply only to native Apple projects.",
    );
  }
  if (ctx.framework.dep === "ios") {
    assertIOSUsableFlags(options);
    return withNativeProgress(async () =>
      runAppleInit({ ...options, root: ctx.cwd, agent }, async () => {
        const applicationId = await authenticateAndLink(ctx.cwd, options.app, undefined, { agent });
        if (!applicationId) throwUsageError("Select a Clerk application before native setup.");
        return applicationId;
      }),
    );
  }
  if (options.dryRun || options.json)
    throwUsageError("--dry-run and --json are supported for native Apple setup only.");
  setTelemetryStage("strategy");
  await enrichProjectContext(ctx);

  // Skip auth-related I/O entirely when the user opted into accountless setup — those
  // values are not consumed once the strategy resolves to "keyless".
  //
  // Validate stored sessions when choosing between authenticated and accountless
  // setup. An explicit authenticated flow can open the browser for the user.
  const authed = optsAccountless
    ? false
    : agent
      ? await isAuthenticatedForAgent()
      : await isAuthenticated();
  const linkedProfile =
    !optsAccountless && agent && !options.app ? await resolveProfile(ctx.cwd) : undefined;
  const hasRealAppTarget = Boolean(options.app || linkedProfile);

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
    const createIfMissing = agent
      ? await deriveProjectName(ctx.cwd, bootstrap?.projectName)
      : undefined;
    await authenticateAndLink(ctx.cwd, options.app, createIfMissing);
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
      printBootstrapManualSetupInfo(ctx.framework);
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

  // Native platforms (Apple/Android) have no npx/Node toolchain to run `skills add` with.
  if (options.skills !== false && isNpmFramework(ctx.framework)) {
    setTelemetryStage("skills");
    bar();
    await installSkills(ctx.cwd, ctx.framework.dep, ctx.packageManager, overrides.skipConfirm);
  }

  // Next steps print last so they stay on screen as the final thing the user sees.
  if (bootstrap) {
    bar();
    printBootstrapNextSteps(bootstrap, strategy === "keyless");
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
function assertUsableFlags(options: InitOptions, accountless: boolean): void {
  if (options.dryRun && options.allowDirty) {
    throwUsageError("--allow-dirty applies only when clerk init is making local changes.");
  }
  if (options.dryRun && options.appIdPrefix != null) {
    throwUsageError(
      "--app-id-prefix cannot be combined with --dry-run because dry-run never reads or changes remote application state.",
    );
  }
  if (options.appIdPrefix != null && !/^[A-Z0-9]{10}$/.test(options.appIdPrefix.trim())) {
    throwUsageError(
      "--app-id-prefix must contain exactly 10 ASCII letters or numbers after trimming.",
    );
  }
  if (options.dryRun && options.starter) {
    throwUsageError(
      "--dry-run cannot be combined with --starter because dry-run never creates files.",
    );
  }
  if (
    options.starter &&
    (options.target ||
      options.allowDirty ||
      options.appIdPrefix ||
      options.signInWithApple ||
      options.prebuiltAuthUI ||
      options.sdk)
  ) {
    throwUsageError(
      "--target, --allow-dirty, --app-id-prefix, --sign-in-with-apple, --prebuilt-auth-ui, and --sdk require an existing native Apple project and cannot be combined with --starter.",
    );
  }
  if (
    options.dryRun &&
    (options.app || accountless || options.login || options.template || options.fresh)
  ) {
    throwUsageError(
      "--dry-run cannot be combined with --app, --accountless, --login, --template, or --fresh because it never reads or changes remote application state.",
    );
  }
  if (accountless && options.login) {
    throwUsageError("--accountless and --login cannot be combined.");
  }
  if (accountless && options.app) {
    throwUsageError(
      "--accountless cannot be combined with --app. Drop --accountless to link the app, or drop --app to use temporary development keys.",
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
}

/**
 * Rejects accountless-only flags before the native Apple apply phase. Native Apple projects do
 * not consume Clerk's accountless bootstrap, so letting strategy resolution reject
 * these later could otherwise modify the Xcode project before a usage error.
 */
function assertIOSUsableFlags(options: InitOptions): void {
  if (options.sdk === "core" && options.prebuiltAuthUI) {
    throwUsageError("--prebuilt-auth-ui requires ClerkKitUI; use --sdk ui or omit --sdk.");
  }

  if (options.accountless || options.keyless) {
    throwUsageError(
      "--accountless is not supported for native Apple projects. Run `clerk auth login` and use `clerk init --app <app_id>` instead.",
    );
  }
  if (options.template) {
    throwUsageError(
      "--template only applies to accountless applications, but native Apple projects do not support accountless mode. Drop --template.",
    );
  }
  if (options.fresh) {
    throwUsageError(
      "--fresh only applies to accountless applications, but native Apple projects do not support accountless mode. Drop --fresh.",
    );
  }
}

/**
 * Preserve accountless selection for an agent whose stored session is stale.
 * Platform API keys are checked by the actual setup requests, without an extra
 * account-wide application-list request before setup.
 */
async function isAuthenticatedForAgent(): Promise<boolean> {
  if (process.env.CLERK_PLATFORM_API_KEY) return true;
  return (await getAuthenticatedEmail()) !== null;
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

async function resolveExistingProjectContext(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
): Promise<ResolvedContext> {
  const ctx = await withNativeSpinner("Inspecting project...", async () =>
    gatherContext(cwd, frameworkOverride, overrides.pmOverride),
  );
  if (!ctx) {
    throw new CliError(
      "Could not detect an existing native Apple project. --target, --allow-dirty, --app-id-prefix, --sign-in-with-apple, --prebuilt-auth-ui, and --sdk never bootstrap a new project.",
      { code: ERROR_CODE.FRAMEWORK_UNDETECTED },
    );
  }
  return { ctx, bootstrap: null };
}

async function resolveReadOnlyProjectContext(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
  machineOutput: boolean,
): Promise<ResolvedContext> {
  const detect = async () => gatherContext(cwd, frameworkOverride, overrides.pmOverride);
  const ctx = machineOutput
    ? await detect()
    : await withNativeSpinner("Inspecting project...", detect);
  if (!ctx) {
    throw new CliError(
      "Could not detect an existing project. Read-only mode never bootstraps or modifies a directory.",
      { code: ERROR_CODE.FRAMEWORK_UNDETECTED },
    );
  }
  return { ctx, bootstrap: null };
}

// --- Next steps ---

function devCommand(pm: string): string {
  return pm === "npm" ? "npm run dev" : `${pm} dev`;
}

function printBootstrapNextSteps(
  { projectName, packageManager }: BootstrapResult,
  accountless: boolean,
): void {
  const steps = [`cd ${projectName}`, devCommand(packageManager)];
  if (accountless) {
    steps.push("clerk auth login  (when you're ready to connect your Clerk account)");
  }
  printNextSteps(steps);
}

function printBootstrapManualSetupInfo(framework: FrameworkInfo): void {
  // Only reachable for frameworks without accountless support: capable ones resolve to
  // the internal "keyless" or "authenticate" strategy in agent mode instead.
  const lines = [
    `\n  Set up Clerk for ${framework.name}:`,
    `    ${framework.name} requires API keys — set them up manually:`,
    "    clerk init --app <app_id>",
    "    clerk env pull",
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
      printBootstrapManualSetupInfo(ctx.framework);
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

async function resolveAuthLabel(embedded = false): Promise<string> {
  const hasApiKey = Boolean(process.env.CLERK_PLATFORM_API_KEY);
  if (hasApiKey) return "Using API key";

  const email = await getAuthenticatedEmail();
  if (email) return `Logged in as ${email}`;

  await login({ showNextSteps: false, ...(embedded && { embedded: true }) });
  return "";
}

async function authenticateAndLink(
  cwd: string,
  app: string | undefined,
  createIfMissing: string | undefined,
  native?: { agent: boolean },
): Promise<string | undefined> {
  const label = await resolveAuthLabel(Boolean(native));
  const profile = await resolveProfile(cwd);

  if (native?.agent && !app && !profile) {
    throwUsageError(
      `${label === "Using API key" ? "Using a Platform API key." : "You're signed in."} ` +
        "Setup needs a Clerk application. Run `clerk apps list --json`. " +
        "Reuse a unique match to the selected Xcode app's existing Clerk publishable key. " +
        "If the list is empty and the app has no existing Clerk configuration, " +
        'run `clerk apps create "<Xcode-app-name>" --json`. ' +
        "Otherwise, show application names and ask which to use or whether to create one. " +
        "Resolve conflicting configuration or listing errors before proceeding; names and unrelated environment keys are not proof of a match. " +
        "Then rerun `clerk init --app <application-id>` using the selected ID and the same setup options.",
    );
  }

  const alreadyOnRequestedApp = profile && (!app || profile.profile.appId === app);

  if (label && alreadyOnRequestedApp) {
    log.info(dim(`${label} · Linked to ${profile.profile.appId}`));
    return profile.profile.appId;
  }

  if (label) {
    log.info(dim(label));
  }

  await link({
    skipIfLinked: true,
    app,
    cwd,
    createIfMissing,
    ...(native && { skipAutolink: true, embedded: true, agent: native.agent }),
  });

  const linked = app || native ? await resolveProfile(cwd) : undefined;
  if (app && linked?.profile.appId !== app) {
    if (profile && !isAgent() && !native?.agent) throwUserAbort();
    throw new CliError(
      `The project was not linked to the requested Clerk application ${app}. No keys were written.`,
      { code: ERROR_CODE.NOT_LINKED },
    );
  }
  if (native && !linked) {
    throw new CliError("The Clerk application link could not be verified. No keys were written.", {
      code: ERROR_CODE.NOT_LINKED,
    });
  }
  return linked?.profile.appId;
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
  // The dedicated iOS phase already handled its Xcode package graph. Other
  // non-npm ecosystems (for example Gradle) print install steps from their
  // framework scaffold plan.

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
      createOption("--framework <name>", "Framework to set up (skips auto-detection)").choices(
        FRAMEWORK_NAMES,
      ),
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
      "Inspect an existing Xcode project and print an iOS/macOS setup plan without changing local or remote state",
    )
    .option("--json", "Output native Apple setup results and the agent handoff as JSON")
    .option("--project <path>", "Select an Xcode project or workspace")
    .option("--configuration <name>", "Select a custom build configuration")
    .option("--bundle-id <id>", "Confirm an ambiguous Bundle ID")
    .option(
      "--target <name-or-id>",
      "Select a native Apple application target by name or PBX object ID",
    )
    .addOption(
      createOption(
        "--allow-dirty",
        "Legacy flag; setup preserves existing edits in backups",
      ).hideHelp(),
    )
    .option(
      "--app-id-prefix <prefix>",
      "10-character Apple App ID Prefix to use when Clerk needs to register the selected Bundle ID",
    )
    .option(
      "--sign-in-with-apple",
      "Enable native Sign in with Apple for the selected native Apple target",
    )
    .option(
      "--prebuilt-auth-ui",
      "Add ClerkKitUI's prebuilt AuthView flow to a proven pristine SwiftUI target",
    )
    .addOption(
      createOption(
        "--sdk <products>",
        "Native Apple SDK products: core (ClerkKit) or ui (ClerkKit + ClerkKitUI); does not insert AuthView",
      ).choices(["core", "ui"]),
    )
    .option("-y, --yes", "Skip confirmation prompts")
    .option("--no-skills", "Skip the optional agent skills install prompt")
    .setExamples([
      {
        command: "clerk init",
        description: "Auto-detect framework and set up Clerk",
      },
      {
        command: "clerk init --framework next",
        description: "Set up for Next.js (skips detection)",
      },
      {
        command: "clerk init --app app_123",
        description: "Link to a specific Clerk application",
      },
      {
        command: "clerk init --starter",
        description: "Create a new project with Clerk",
      },
      {
        command: "clerk init --starter --framework next --pm bun",
        description: "Bootstrap with Bun",
      },
      {
        command: "clerk init --starter --framework next --accountless",
        description: "Bootstrap with temporary dev keys, even when logged in",
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
        command: "clerk init --dry-run",
        description: "Inspect a native Apple project and print its setup plan without changes",
      },
      {
        command: "clerk init --dry-run --target MyApp --json",
        description: "Inspect one native Apple app target and emit a machine-readable plan",
      },
      {
        command: "clerk init -y",
        description: "Skip all confirmation prompts",
      },
      {
        command: "clerk init --no-skills",
        description: "Skip the agent skills install prompt",
      },
    ])
    .action(init);
}
