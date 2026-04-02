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
import { intro, outro, bar, withSpinner } from "../../lib/spinner.js";
import type { ProjectContext } from "./frameworks/types.js";

interface InitOptions {
  framework?: string;
  yes?: boolean;
  prompt?: boolean;
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

  await detectAndInstall(cwd, ctx, options);

  bar();
  if (authenticated) {
    await pull({});
  } else {
    printKeylessInfo();
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

async function detectAndInstall(
  cwd: string,
  ctx: ProjectContext | null,
  options: InitOptions,
): Promise<void> {
  if (!ctx) {
    console.log(
      `Could not detect a framework. Install the appropriate Clerk SDK manually: ${dim("https://clerk.com/docs")}`,
    );
    return;
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

  await scaffoldAndWrite(cwd, ctx, options);
}

async function scaffoldAndWrite(
  cwd: string,
  ctx: ProjectContext,
  options: InitOptions,
): Promise<void> {
  const plan = await scaffold(ctx);
  const hasChanges = plan.actions.some((a) => a.type !== "skip");

  if (!hasChanges && plan.postInstructions.length === 0) {
    console.log(green("\nClerk is already set up in this project."));
    return;
  }

  if (!hasChanges) {
    console.log(dim("\nNo files to scaffold, but:"));
    for (const instr of plan.postInstructions) {
      console.log(dim(`  • ${instr}`));
    }
    return;
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
}
