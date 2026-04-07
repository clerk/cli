import { login } from "../auth/login.js";
import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { isAgent } from "../../mode.js";
import { dim, green, yellow, bold } from "../../lib/color.js";
import { throwUserAbort, CliError } from "../../lib/errors.js";
import { lookupFramework, type FrameworkInfo } from "../../lib/framework.js";
import { resolveProfile } from "../../lib/config.js";
import { printNextSteps } from "../../lib/next-steps.js";
import { gatherContext, hasPackageJson } from "./context.js";
import { scaffold, enrichProjectContext } from "./scaffold.js";
import { previewPlan, previewAndConfirm } from "./preview.js";
import { runFormatters } from "./format.js";
import { detectAuthLibraries, scanForIssues } from "./scan.js";
import {
  installSdk,
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
  type BootstrapResult,
} from "./bootstrap.js";
import type { ProjectContext } from "./frameworks/types.js";

type InitOptions = {
  framework?: string;
  yes?: boolean;
  prompt?: boolean;
  skills?: boolean;
  starter?: boolean;
};

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();

  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework) ?? undefined)
    : undefined;

  if (options.prompt || isAgent()) {
    console.log(
      "Run `clerk init -y` to automatically detect the framework, install the Clerk SDK, and scaffold authentication files without interactive prompts.",
    );
    return;
  }

  intro("clerk init");

  const resolved = options.starter
    ? await handleStarter(cwd, frameworkOverride, options.yes)
    : await resolveProjectContext(cwd, frameworkOverride, options.yes);

  if (!resolved) return;

  const { ctx, bootstrap } = resolved;

  if (bootstrap) {
    ctx.isBootstrap = true;
  }

  await enrichProjectContext(ctx);

  const keyless = bootstrap ? options.yes || (await askSkipAuth()) : false;
  ctx.keyless = keyless;

  if (!keyless) {
    bar();
    await authenticateAndLink(ctx.cwd);
  }

  // Short-circuit on a fully-clean re-run so env pull / skills prompt don't
  // execute when there's nothing to do.
  const { alreadySetUp } = await detectAndInstall(ctx.cwd, ctx, options);

  if (alreadySetUp) {
    console.log(green("\nClerk is already set up in this project."));
    outro("Done");
    return;
  }

  bar();
  if (!keyless) {
    await pull({});
  } else {
    printKeylessInfo();
  }

  if (bootstrap) {
    printBootstrapNextSteps(bootstrap, keyless);
  }

  if (options.skills !== false) {
    bar();
    await installSkills(cwd, ctx?.framework.dep, options.yes ?? false);
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
  frameworkOverride?: FrameworkInfo,
  skipConfirm = false,
): Promise<ResolvedContext> {
  const bootstrap = await promptAndBootstrap(cwd, frameworkOverride, { skipConfirm });

  const ctx = await gatherContext(bootstrap.projectDir);
  if (!ctx) {
    throw new CliError("Project generation did not produce a detectable framework.");
  }
  return { ctx, bootstrap };
}

async function handleStarter(
  cwd: string,
  frameworkOverride?: FrameworkInfo,
  skipConfirm = false,
): Promise<ResolvedContext> {
  if (!skipConfirm) {
    await confirmOverwrite(cwd);
  }

  return bootstrapAndDetect(cwd, frameworkOverride, true);
}

async function resolveProjectContext(
  cwd: string,
  frameworkOverride?: FrameworkInfo,
  skipConfirm = false,
): Promise<ResolvedContext> {
  const ctx = await withSpinner("Detecting framework...", () =>
    gatherContext(cwd, frameworkOverride),
  );
  if (ctx) return { ctx, bootstrap: null };

  const isBlank = !(await hasPackageJson(cwd));

  if (!isBlank) {
    throw new CliError(
      `Could not detect a framework. Install the appropriate Clerk SDK manually: https://clerk.com/docs`,
    );
  }

  return bootstrapAndDetect(cwd, frameworkOverride, skipConfirm);
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

async function resolveAuthLabel(): Promise<string> {
  const hasApiKey = Boolean(process.env.CLERK_PLATFORM_API_KEY);
  if (hasApiKey) return "Using API key";

  const email = await getAuthenticatedEmail();
  if (email) return `Logged in as ${email}`;

  await login({ showNextSteps: false });
  return "";
}

async function authenticateAndLink(cwd: string): Promise<void> {
  const label = await resolveAuthLabel();
  const profile = await resolveProfile(cwd);

  if (label && profile) {
    console.log(dim(`${label} · Linked to ${profile.profile.appId}`));
    return;
  }

  if (label) {
    console.log(dim(label));
  }

  await link({ skipIfLinked: true });
}

// --- Detect & install ---

async function detectAndInstall(
  cwd: string,
  ctx: ProjectContext,
  options: InitOptions,
): Promise<{ alreadySetUp: boolean }> {
  const variantLabel = ctx.variant ? ` (${ctx.variant})` : "";
  console.log(`\nDetected ${bold(ctx.framework.name)}${variantLabel}`);

  detectAuthLibraries(ctx.deps);
  console.log();

  if (ctx.existingClerk) {
    console.log(dim(`${ctx.framework.sdk} is already installed`));
  } else {
    await installSdk(ctx);
  }

  return await scaffoldAndWrite(cwd, ctx, options);
}

async function scaffoldAndWrite(
  cwd: string,
  ctx: ProjectContext,
  options: InitOptions,
): Promise<{ alreadySetUp: boolean }> {
  const plan = await scaffold(ctx);
  const hasChanges = plan.actions.some((a) => a.type !== "skip");

  // Fully-clean re-run: signal to init() to skip env pull / skills install.
  if (!hasChanges && plan.postInstructions.length === 0) {
    return { alreadySetUp: true };
  }

  if (!hasChanges) {
    console.log(dim("\nNo files to scaffold, but:"));
    for (const instr of plan.postInstructions) {
      console.log(dim(`  • ${instr}`));
    }
    return { alreadySetUp: false };
  }

  if (await checkGitDirty(cwd)) {
    console.log(yellow("Warning: You have uncommitted changes"));
    console.log(dim("Consider committing first so you can review what clerk init creates.\n"));
  }

  if (options.yes) {
    previewPlan(plan);
  } else {
    const proceed = await previewAndConfirm(plan);
    if (!proceed) throwUserAbort();
  }

  const writtenFiles = await writePlan(cwd, plan);
  await runFormatters(cwd, writtenFiles);

  const findings = await withSpinner("Scanning for issues...", () =>
    scanForIssues(cwd, ctx.framework.dep),
  );
  printOutro(plan, findings);

  return { alreadySetUp: false };
}
