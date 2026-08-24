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

type InitOptions = {
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
  /** Force keyless mode (auto-generated dev keys, no login). Only valid on keyless-capable frameworks. */
  keyless?: boolean;
  /** Force the authenticated flow (log in and link a real app) instead of defaulting to keyless. */
  login?: boolean;
  /** Pre-configure the keyless application from a Clerk application template. */
  template?: KeylessTemplate;
  /** Replace an existing unclaimed keyless application instead of keeping it. */
  fresh?: boolean;
};

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();
  const agent = isAgent();

  setTelemetryStage("flags");
  await assertUsableFlags(options, agent);

  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework) ?? undefined)
    : undefined;

  // In agent mode, implicitly enable --yes to skip all confirmation prompts.
  const overrides: BootstrapOverrides = {
    skipConfirm: options.yes || agent,
    pmOverride: options.pm,
    nameOverride: options.name,
  };

  intro("Setting up Clerk");

  setTelemetryStage("detect");
  const resolved = options.starter
    ? await handleStarter(cwd, frameworkOverride, overrides)
    : await resolveProjectContext(cwd, frameworkOverride, overrides);

  if (!resolved) return;

  const { ctx, bootstrap } = resolved;

  if (bootstrap) {
    ctx.isBootstrap = true;
  }

  await enrichProjectContext(ctx);

  const optsKeyless = options.keyless === true;
  // Skip auth-related I/O entirely when the user opted into keyless — those
  // values are not consumed once the strategy resolves to "keyless".
  //
  // Agent mode has no way to recover if this lies: a human who turns out to be
  // unauthenticated just gets prompted to log in, but an agent that trusts a
  // stale/broken credential ends up blocked on an interactive browser OAuth
  // round-trip it can never complete. So agent mode validates the credential
  // (it can fall back to keyless) instead of trusting mere presence.
  setTelemetryStage("strategy");
  const authed = optsKeyless
    ? false
    : agent
      ? await isAuthenticatedForAgent()
      : await isAuthenticated();
  const linkedProfile =
    !optsKeyless && agent && !options.app ? await resolveProfile(ctx.cwd) : undefined;
  const hasRealAppTarget = Boolean(options.app || linkedProfile);

  const strategy = pickStrategy({
    optsKeyless,
    optsLogin: options.login === true,
    agent,
    authed,
    isBootstrap: bootstrap != null,
    hasRealAppTarget,
    framework: ctx.framework,
  });

  assertKeylessOnlyFlags(options, strategy);

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

  // Native platforms (iOS/Android) have no npx/Node toolchain to run `skills add` with.
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
 * bootstrapped on disk. `--keyless`, `--template`, and `--fresh` describe an
 * application the CLI creates; `--login` and `--app` describe one that
 * already exists.
 */
async function assertUsableFlags(options: InitOptions, agent: boolean): Promise<void> {
  if (options.keyless && options.login) {
    throwUsageError("--keyless and --login cannot be combined.");
  }
  if (options.keyless && options.app) {
    throwUsageError(
      "--keyless cannot be combined with --app. Drop --keyless to link the app, or drop --app to use temporary development keys.",
    );
  }
  if (options.template && options.login) {
    throwUsageError(
      "--template applies to keyless applications and cannot be combined with --login.",
    );
  }
  if (options.fresh && options.login) {
    throwUsageError("--fresh applies to keyless applications and cannot be combined with --login.");
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
  return (await getAuthenticatedEmail()) !== null;
}

/**
 * `--template` and `--fresh` only take effect when init creates a keyless
 * application. Silently dropping them when the strategy resolves elsewhere
 * (the pre-fix behaviour for `--template`) leaves the user believing they got
 * a shaped or replaced app when they didn't — so fail loudly instead, the
 * same way `--keyless`+`--app` does above. This runs after strategy
 * resolution because that's the earliest point the real strategy — not just
 * the flags that might influence it — is known.
 */
function assertKeylessOnlyFlags(options: InitOptions, strategy: InitStrategy): void {
  if (strategy === "keyless") return;

  const reason =
    strategy === "manual"
      ? "this framework does not support keyless mode"
      : "this run resolved to the authenticated flow instead (already signed in, --app was set, or a project is already linked)";

  if (options.template) {
    throwUsageError(
      `--template only applies to keyless applications, but ${reason}. Add --keyless to force a keyless app, or drop --template.`,
    );
  }
  if (options.fresh) {
    throwUsageError(
      `--fresh only applies to keyless applications, but ${reason}. Add --keyless to force a keyless app, or drop --fresh.`,
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

// --- Next steps ---

function devCommand(pm: string): string {
  return pm === "npm" ? "npm run dev" : `${pm} dev`;
}

function printBootstrapNextSteps(
  { projectName, packageManager }: BootstrapResult,
  keyless: boolean,
): void {
  const steps = [`cd ${projectName}`, devCommand(packageManager)];
  if (keyless) {
    steps.push("clerk auth login  (when you're ready to connect your Clerk account)");
  }
  printNextSteps(steps);
}

function printBootstrapManualSetupInfo(framework: FrameworkInfo): void {
  // Only reachable for non-keyless frameworks: keyless-capable ones resolve to
  // the "keyless" or "authenticate" strategy in agent mode instead.
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
// - "keyless"      → temporary development keys, no login. Forced via `--keyless`, or the default
//                    for unauthenticated runs on a keyless-capable framework (human bootstrap and
//                    all agent runs). A `.clerk/keyless.json` breadcrumb lets the next
//                    `clerk auth login` claim the app automatically.
// - "manual"       → agent mode on a non-keyless framework without a real app target — scaffold
//                    locally and print guidance instead of running OAuth.
// - "authenticate" → log in (interactively if needed) and link a real Clerk application. Forced
//                    via `--login`, and the default whenever keyless doesn't apply.
function pickStrategy({
  optsKeyless,
  optsLogin,
  agent,
  authed,
  isBootstrap,
  hasRealAppTarget,
  framework,
}: {
  optsKeyless: boolean;
  optsLogin: boolean;
  agent: boolean;
  authed: boolean;
  isBootstrap: boolean;
  hasRealAppTarget: boolean;
  framework: FrameworkInfo;
}): InitStrategy {
  if (optsKeyless) {
    if (!framework.supportsKeyless) {
      throwUsageError(
        `--keyless is not supported for ${framework.name}. Run \`clerk auth login\` and use \`clerk init --app <app_id>\` instead.`,
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

async function resolveAuthLabel(): Promise<string> {
  const hasApiKey = Boolean(process.env.CLERK_PLATFORM_API_KEY);
  if (hasApiKey) return "Using API key";

  const email = await getAuthenticatedEmail();
  if (email) return `Logged in as ${email}`;

  await login({ showNextSteps: false });
  return "";
}

async function authenticateAndLink(
  cwd: string,
  app: string | undefined,
  createIfMissing: string | undefined,
): Promise<void> {
  const label = await resolveAuthLabel();
  const profile = await resolveProfile(cwd);

  const alreadyOnRequestedApp = profile && (!app || profile.profile.appId === app);

  if (label && alreadyOnRequestedApp) {
    log.info(dim(`${label} · Linked to ${profile.profile.appId}`));
    return;
  }

  if (label) {
    log.info(dim(label));
  }

  await link({ skipIfLinked: true, app, cwd, createIfMissing });
}

// --- Keyless app setup ---

/**
 * A `.clerk/keyless.json` breadcrumb means an earlier run already minted an
 * unclaimed keyless application for this project — its claim token, and the
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
      ? `This project already has an unclaimed keyless application (created ${existing.createdAt}). Replace it with a new one?`
      : "This project already has an unclaimed keyless application (minted by its Clerk SDK in `.clerk/.tmp/keyless.json`). Replace it with a new one?",
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
      "--keyless",
      "Force keyless development keys, even when logged in (only for keyless-capable frameworks)",
    )
    .option(
      "--login",
      "Force the authenticated flow: log in and link a real application instead of keyless keys",
    )
    .addOption(
      createOption(
        "--template <name>",
        "Pre-configure the keyless application from a Clerk application template. Only applies when the strategy resolves to keyless — errors otherwise",
      ).choices(KEYLESS_TEMPLATES),
    )
    .option(
      "--fresh",
      "Replace an existing unclaimed keyless application with a new one, instead of keeping it. Only applies when the strategy resolves to keyless — errors otherwise",
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
        command: "clerk init --starter --framework next --keyless",
        description: "Bootstrap with temporary dev keys, even when logged in",
      },
      {
        command: "clerk init --login",
        description: "Log in and link a real application instead of keyless keys",
      },
      {
        command: "clerk init --template b2b-saas",
        description: "Bootstrap a keyless app pre-configured for B2B SaaS",
      },
      {
        command: "clerk init --keyless --fresh",
        description: "Replace an existing unclaimed keyless app with a new one",
      },
      { command: "clerk init -y", description: "Skip all confirmation prompts" },
      { command: "clerk init --no-skills", description: "Skip the agent skills install prompt" },
    ])
    .action(init);
}
