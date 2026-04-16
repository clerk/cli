import { login } from "../auth/login.js";
import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { isAgent } from "../../mode.js";
import { dim, bold } from "../../lib/color.js";
import { throwUserAbort, CliError } from "../../lib/errors.js";
import { lookupFramework, type FrameworkInfo } from "../../lib/framework.js";
import { resolveProfile } from "../../lib/config.js";
import { log } from "../../lib/log.js";
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
  getAuthenticatedEmail,
} from "./heuristics.js";
import { installSkills } from "./skills.js";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.js";
import {
  promptAndBootstrap,
  confirmOverwrite,
  askSkipAuth,
  type BootstrapOverrides,
  type BootstrapResult,
} from "./bootstrap.js";
import type { ProjectContext } from "./frameworks/types.js";
import type { PackageManager } from "./bootstrap-registry.js";

type InitOptions = {
  /** Framework to set up (skips auto-detection). */
  framework?: string;
  pm?: PackageManager;
  name?: string;
  yes?: boolean;
  /** Output a prompt for an AI agent to integrate Clerk, then exit. */
  prompt?: boolean;
  /** Install the optional agent skills (set to false via `--no-skills` to skip). */
  skills?: boolean;
  /** Create a new project from a starter template. */
  starter?: boolean;
  /** Link to a specific Clerk application by ID (skips the interactive picker). */
  app?: string;
};

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();

  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework) ?? undefined)
    : undefined;

  if (options.prompt) {
    log.data(
      "Run `clerk init -y` to automatically detect the framework, install the Clerk SDK, and scaffold authentication files without interactive prompts.",
    );
    return;
  }

  // In agent mode, implicitly enable --yes to skip all confirmation prompts.
  const overrides: BootstrapOverrides = {
    skipConfirm: options.yes || isAgent(),
    pmOverride: options.pm,
    nameOverride: options.name,
  };

  intro("clerk init");

  const resolved = options.starter
    ? await handleStarter(cwd, frameworkOverride, overrides)
    : await resolveProjectContext(cwd, frameworkOverride, overrides);

  if (!resolved) return;

  const { ctx, bootstrap } = resolved;

  if (bootstrap) {
    ctx.isBootstrap = true;
  }

  await enrichProjectContext(ctx);

  const keyless = await resolveKeylessMode(bootstrap, ctx, overrides.skipConfirm);
  ctx.keyless = keyless;

  const skipAuth =
    !keyless && bootstrap != null && overrides.skipConfirm && !(await getAuthenticatedEmail());

  if (!keyless && !skipAuth) {
    bar();
    await authenticateAndLink(ctx.cwd, options.app);
  }

  // Short-circuit on a fully-clean re-run so env pull / skills prompt don't
  // execute when there's nothing to do.
  const { alreadySetUp } = await detectAndInstall(ctx.cwd, ctx, overrides.skipConfirm);

  if (alreadySetUp) {
    log.success("\nClerk is already set up in this project.");
    outro("Done");
    return;
  }

  bar();
  if (skipAuth) {
    printBootstrapManualSetupInfo(ctx.framework.name);
  } else if (!keyless) {
    await pull({ file: ctx.envFile });
  } else {
    printKeylessInfo();
  }

  if (bootstrap) {
    printBootstrapNextSteps(bootstrap, keyless);
  }

  if (options.skills !== false) {
    bar();
    await installSkills(ctx.cwd, ctx.framework.dep, ctx.packageManager, overrides.skipConfirm);
  }

  outro("Done");
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
  const bootstrap = await promptAndBootstrap(cwd, frameworkOverride, overrides);

  const ctx = await gatherContext(bootstrap.projectDir);
  if (!ctx) {
    throw new CliError("Project generation did not produce a detectable framework.");
  }
  return { ctx, bootstrap };
}

async function handleStarter(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
): Promise<ResolvedContext> {
  if (!overrides.skipConfirm) {
    await confirmOverwrite(cwd);
  }

  return bootstrapAndDetect(cwd, frameworkOverride, { ...overrides, skipConfirm: true });
}

async function resolveProjectContext(
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  overrides: BootstrapOverrides,
): Promise<ResolvedContext> {
  const ctx = await withSpinner("Detecting framework...", () =>
    gatherContext(cwd, frameworkOverride, overrides.pmOverride),
  );
  if (ctx) return { ctx, bootstrap: null };

  const isBlank = !(await hasPackageJson(cwd));

  if (!isBlank) {
    throw new CliError(
      `Could not detect a framework. Install the appropriate Clerk SDK manually: https://clerk.com/docs`,
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

function printBootstrapManualSetupInfo(frameworkName: string): void {
  const lines = [
    `\n  ${frameworkName} requires API keys — set them up manually:`,
    "    clerk auth login",
    "    clerk link",
    "    clerk env pull",
  ];
  log.info(lines.map(dim).join("\n"));
}

// --- Keyless ---

async function resolveKeylessMode(
  bootstrap: BootstrapResult | null,
  ctx: ProjectContext,
  skipConfirm: boolean,
): Promise<boolean> {
  if (ctx.framework.supportsKeyless) {
    // Already authenticated — go straight to the authenticated flow.
    const email = await getAuthenticatedEmail();
    if (email) return false;

    return skipConfirm || (await askSkipAuth());
  }

  if (bootstrap) {
    log.info(
      dim(
        `\n  ${ctx.framework.name} requires API keys — keyless mode is not yet supported for this framework.`,
      ),
    );
  }
  return false;
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

async function authenticateAndLink(cwd: string, app: string | undefined): Promise<void> {
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

  await link({ skipIfLinked: true, app });
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
  } else {
    await installSdk(ctx);
  }

  return await scaffoldAndWrite(cwd, ctx, skipConfirm);
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

  const findings = await withSpinner("Scanning for issues...", () =>
    scanForIssues(cwd, ctx.framework.dep),
  );
  printOutro(plan, findings);

  return { alreadySetUp: false };
}
