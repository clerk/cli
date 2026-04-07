import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { isAgent } from "../../mode.js";
import { dim, green, yellow, bold } from "../../lib/color.js";
import { throwUserAbort } from "../../lib/errors.js";
import { lookupFramework } from "../../lib/framework.js";
import { resolveProfile } from "../../lib/config.js";
import { gatherContext } from "./context.js";
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
import type { ProjectContext } from "./frameworks/types.js";

interface InitOptions {
  framework?: string;
  yes?: boolean;
  prompt?: boolean;
  skills?: boolean;
}

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();

  // Commander validates --framework against FRAMEWORK_NAMES choices
  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework) ?? undefined)
    : undefined;

  intro("clerk init");

  const ctx = await withSpinner("Detecting framework...", () =>
    gatherContext(cwd, frameworkOverride),
  );

  // Populate framework-specific context (variant, layoutPath, middlewareBasename)
  if (ctx) await enrichProjectContext(ctx);

  if (options.prompt || isAgent()) {
    console.log(
      "Run `clerk init -y` to automatically detect the framework, install the Clerk SDK, and scaffold authentication files without interactive prompts.",
    );
    outro();
    return;
  }

  bar();
  const authenticated = await resolveAuth(cwd);

  if (authenticated) {
    await link({ skipIfLinked: true });
  }

  // Short-circuit on a fully-clean re-run so env pull / skills prompt don't
  // execute when there's nothing to do.
  const { alreadySetUp } = await detectAndInstall(cwd, ctx, options);

  if (alreadySetUp) {
    console.log(green("\nClerk is already set up in this project."));
    outro("Done");
    return;
  }

  bar();
  if (authenticated) {
    await pull({});
  } else {
    printKeylessInfo();
  }

  if (options.skills !== false) {
    bar();
    await installSkills(cwd, ctx?.framework.dep, options.yes ?? false);
  }

  outro("Done");
}

async function resolveAuth(cwd: string): Promise<boolean> {
  const hasApiKey = Boolean(process.env.CLERK_PLATFORM_API_KEY);
  const email = hasApiKey ? null : await getAuthenticatedEmail();

  if (!hasApiKey && !email) return false;

  const profile = await resolveProfile(cwd);
  const linkedInfo = profile ? ` · Linked to ${profile.profile.appId}` : "";
  const authLabel = hasApiKey ? "Using API key" : `Logged in as ${email}`;
  console.log(dim(`${authLabel}${linkedInfo}`));
  return true;
}

/**
 * Run framework detection, SDK install, and scaffolding.
 *
 * Returns `alreadySetUp: true` only when the project has a supported
 * framework, the SDK is installed, all scaffold actions are skips, and there
 * are no postInstructions — i.e. a fully-clean re-run. The "no framework"
 * and "framework detected but unsupported" branches return `false` so the
 * caller still pulls env keys and offers the skills install.
 */
async function detectAndInstall(
  cwd: string,
  ctx: ProjectContext | null,
  options: InitOptions,
): Promise<{ alreadySetUp: boolean }> {
  if (!ctx) {
    console.log(
      `Could not detect a framework. Install the appropriate Clerk SDK manually: ${dim("https://clerk.com/docs")}`,
    );
    return { alreadySetUp: false };
  }

  const variantLabel = ctx.variant ? ` (${ctx.variant})` : "";
  console.log(`\nDetected ${bold(ctx.framework.name)}${variantLabel}`);

  detectAuthLibraries(ctx.deps);
  console.log();

  if (ctx.existingClerk) {
    console.log(dim(`${ctx.framework.sdk} is already installed.`));
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

  // Post-scaffold: scan for issues
  const findings = await withSpinner("Scanning for issues...", () =>
    scanForIssues(cwd, ctx.framework.dep),
  );
  printOutro(plan, findings);

  return { alreadySetUp: false };
}
