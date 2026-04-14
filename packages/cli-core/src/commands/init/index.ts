import type { Need } from "../../lib/deps.ts";
import { login } from "../auth/login.ts";
import { linkIfNeeded, type LinkIfNeededDeps } from "../link/helpers/link-if-needed.ts";
import { pullDefault, type PullDefaultDeps } from "../env/helpers/pull-default.ts";
import { dim, green, yellow, bold } from "../../lib/color.ts";
import { throwUserAbort, CliError } from "../../lib/errors.ts";
import { lookupFramework, type FrameworkInfo } from "../../lib/framework.ts";
import { printNextSteps } from "../../lib/next-steps.ts";
import { scaffold, enrichProjectContext } from "./scaffold.ts";
import { previewPlan, previewAndConfirm } from "./preview.ts";
import { runFormatters } from "./format.ts";
import { detectAuthLibraries, scanForIssues } from "./scan.ts";
import {
  installSdk,
  installDeps,
  writePlan,
  checkGitDirty,
  printOutro,
  printKeylessInfo,
  getAuthenticatedEmail,
} from "./heuristics.ts";
import { installSkills, type InstallSkillsDeps } from "./skills.ts";
import {
  promptAndBootstrap,
  confirmOverwrite,
  askSkipAuth,
  type BootstrapOverrides,
  type BootstrapResult,
} from "./bootstrap.ts";
import type { ProjectContext } from "./frameworks/types.ts";
import type { PackageManager } from "./bootstrap-registry.ts";

export interface InitOptions {
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
}

/**
 * Init's slice. The link-if-needed and pull-default helpers cover the
 * collaborator surface for the linking + env-pull subflows; the rest
 * (projectDetector, mode, configStore, env, spinner) are touched directly.
 */
export type InitDeps = Need<{
  projectDetector: "gather" | "hasPackageJson";
  mode: "isAgent";
  configStore: "resolveProfile";
  credentialStore: "getToken";
  tokenExchange: "fetchUserInfo";
  env: "get";
  spinner: "intro" | "outro" | "bar" | "withSpinner";
  log: "info" | "warn" | "data";
  system: "which" | "runInherit" | "runCapture" | "spawn";
  runners: "*";
}> &
  LinkIfNeededDeps &
  PullDefaultDeps &
  InstallSkillsDeps;

export async function init(deps: InitDeps, options: InitOptions = {}): Promise<void> {
  const cwd = process.cwd();

  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework) ?? undefined)
    : undefined;

  if (options.prompt || deps.mode.isAgent()) {
    deps.log.data(
      "Run `clerk init -y` to automatically detect the framework, install the Clerk SDK, and scaffold authentication files without interactive prompts.",
    );
    return;
  }

  deps.spinner.intro("clerk init");

  const resolved = options.starter
    ? await handleStarter(deps, cwd, frameworkOverride, options.yes)
    : await resolveProjectContext(deps, cwd, frameworkOverride, options.yes);

  if (!resolved) return;

  const { ctx, bootstrap } = resolved;

  if (bootstrap) {
    ctx.isBootstrap = true;
  }

  await enrichProjectContext(ctx);

  const keyless = bootstrap ? options.yes || (await askSkipAuth(deps)) : false;
  ctx.keyless = keyless;

  if (!keyless) {
    deps.spinner.bar();
    await authenticateAndLink(deps, ctx.cwd);
  }

  // Short-circuit on a fully-clean re-run so env pull / skills prompt don't
  // execute when there's nothing to do.
  const { alreadySetUp } = await detectAndInstall(deps, ctx.cwd, ctx, options.yes ?? false);

  if (alreadySetUp) {
    deps.log.info(green("\nClerk is already set up in this project."));
    deps.spinner.outro("Done");
    return;
  }

  deps.spinner.bar();
  if (!keyless) {
    await pullDefault(deps, { file: ctx.envFile });
  } else {
    printKeylessInfo(deps);
  }

  if (bootstrap) {
    printBootstrapNextSteps(bootstrap, keyless);
  }

  if (options.skills !== false) {
    deps.spinner.bar();
    await installSkills(deps, cwd, ctx?.framework.dep, ctx?.packageManager, options.yes ?? false);
  }

  deps.spinner.outro("Done");
}

type ResolvedContext = {
  ctx: ProjectContext;
  bootstrap: BootstrapResult | null;
};

type ResolveContextDeps = Need<{
  projectDetector: "gather" | "hasPackageJson";
  spinner: "withSpinner";
  prompts: "confirm" | "search" | "input";
  log: "info" | "warn";
  system: "runInherit";
}>;

// --- Bootstrap paths ---

async function bootstrapAndDetect(
  deps: ResolveContextDeps,
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  skipConfirm: boolean = false,
): Promise<ResolvedContext> {
  const bootstrap = await promptAndBootstrap(deps, cwd, frameworkOverride, { skipConfirm });

  const ctx = await deps.projectDetector.gather(bootstrap.projectDir);
  if (!ctx) {
    throw new CliError("Project generation did not produce a detectable framework.");
  }
  return { ctx, bootstrap };
}

async function handleStarter(
  deps: ResolveContextDeps,
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  skipConfirm: boolean = false,
): Promise<ResolvedContext> {
  if (!skipConfirm) {
    await confirmOverwrite(deps, cwd);
  }

  return bootstrapAndDetect(deps, cwd, frameworkOverride, true);
}

async function resolveProjectContext(
  deps: ResolveContextDeps,
  cwd: string,
  frameworkOverride: FrameworkInfo | undefined,
  skipConfirm: boolean = false,
): Promise<ResolvedContext> {
  const ctx = await deps.spinner.withSpinner("Detecting framework...", () =>
    deps.projectDetector.gather(cwd, frameworkOverride),
  );
  if (ctx) return { ctx, bootstrap: null };

  const isBlank = !(await deps.projectDetector.hasPackageJson(cwd));

  if (!isBlank) {
    throw new CliError(
      `Could not detect a framework. Install the appropriate Clerk SDK manually: https://clerk.com/docs`,
    );
  }

  return bootstrapAndDetect(deps, cwd, frameworkOverride, skipConfirm);
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
    steps.push("clerk login  (when you're ready to connect your Clerk account)");
  }
  printNextSteps(steps);
}

// --- Auth ---

type ResolveAuthLabelDeps = Need<{
  env: "get";
  credentialStore: "getToken";
  tokenExchange: "fetchUserInfo";
}> &
  LinkIfNeededDeps;

async function resolveAuthLabel(deps: ResolveAuthLabelDeps): Promise<string> {
  const hasApiKey = Boolean(deps.env.get("CLERK_PLATFORM_API_KEY"));
  if (hasApiKey) return "Using API key";

  const email = await getAuthenticatedEmail(deps);
  if (email) return `Logged in as ${email}`;

  await login(deps, { showNextSteps: false });
  return "";
}

type AuthenticateAndLinkDeps = Need<{
  configStore: "resolveProfile";
  log: "info";
}> &
  ResolveAuthLabelDeps;

async function authenticateAndLink(deps: AuthenticateAndLinkDeps, cwd: string): Promise<void> {
  const label = await resolveAuthLabel(deps);
  const profile = await deps.configStore.resolveProfile(cwd);

  if (label && profile) {
    deps.log.info(dim(`${label} · Linked to ${profile.profile.appId}`));
    return;
  }

  if (label) {
    deps.log.info(dim(label));
  }

  await linkIfNeeded(deps, { skipIfLinked: true });
}

// --- Detect & install ---

type DetectAndInstallDeps = Need<{
  spinner: "withSpinner";
  prompts: "confirm";
  log: "info" | "warn";
  system: "which" | "runInherit" | "runCapture";
}>;

async function detectAndInstall(
  deps: DetectAndInstallDeps,
  cwd: string,
  ctx: ProjectContext,
  skipConfirm: boolean,
): Promise<{ alreadySetUp: boolean }> {
  const variantLabel = ctx.variant ? ` (${ctx.variant})` : "";
  deps.log.info(`\nDetected ${bold(ctx.framework.name)}${variantLabel}`);

  detectAuthLibraries(ctx.deps);
  deps.log.info("");

  if (ctx.existingClerk) {
    deps.log.info(dim(`${ctx.framework.sdk} is already installed`));
  } else {
    await installSdk(deps, ctx);
  }

  return await scaffoldAndWrite(deps, cwd, ctx, skipConfirm);
}

async function scaffoldAndWrite(
  deps: DetectAndInstallDeps,
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
    deps.log.info(dim("\nNo files to scaffold, but:"));
    for (const instr of plan.postInstructions) {
      deps.log.info(dim(`  • ${instr}`));
    }
    return { alreadySetUp: false };
  }

  if (await checkGitDirty(deps, cwd)) {
    deps.log.warn(yellow("You have uncommitted changes"));
    deps.log.info(dim("Consider committing first so you can review what clerk init creates.\n"));
  }

  if (skipConfirm) {
    previewPlan(plan);
  } else {
    const proceed = await previewAndConfirm(deps, plan);
    if (!proceed) throwUserAbort();
  }

  if (plan.additionalDeps?.length) {
    await installDeps(ctx, plan.additionalDeps);
  }

  const writtenFiles = await writePlan(cwd, plan);
  await runFormatters(deps, cwd, writtenFiles);

  const findings = await deps.spinner.withSpinner("Scanning for issues...", () =>
    scanForIssues(cwd, ctx.framework.dep),
  );
  printOutro(deps, plan, findings);

  return { alreadySetUp: false };
}
