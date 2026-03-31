import { login } from "../auth/login.js";
import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { isAgent } from "../../mode.js";
import { dim, green, yellow, bold } from "../../lib/color.js";
import { throwUserAbort } from "../../lib/errors.js";
import { lookupFramework, type FrameworkInfo } from "../../lib/framework.js";
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
  getAuthenticatedEmail,
} from "./heuristics.js";
import type { ProjectContext } from "./frameworks/types.js";

interface InitOptions {
  framework?: string;
  yes?: boolean;
  prompt?: boolean;
}

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();

  // Commander validates --framework against FRAMEWORK_NAMES choices
  let frameworkOverride: FrameworkInfo | undefined;
  if (options.framework) {
    frameworkOverride = lookupFramework(options.framework) ?? undefined;
  }
  const ctx = await gatherContext(cwd, frameworkOverride);

  // Populate framework-specific context (variant, layoutPath, middlewareBasename)
  if (ctx) await enrichProjectContext(ctx);

  if (options.prompt || isAgent()) {
    console.log(
      "Run `clerk init -y` to automatically detect the framework, install the Clerk SDK, and scaffold authentication files without interactive prompts.",
    );
    return;
  }

  await authenticateAndLink(cwd);
  await detectAndInstall(cwd, ctx, options);
}

async function authenticateAndLink(cwd: string): Promise<void> {
  // If Platform API key is set, skip OAuth entirely
  const hasApiKey = Boolean(process.env.CLERK_PLATFORM_API_KEY);
  const profile = await resolveProfile(cwd);

  if (hasApiKey && profile) {
    console.log(dim(`Using API key · Linked to ${profile.profile.appId}`));
    return;
  }

  if (hasApiKey) {
    await link({ skipIfLinked: true });
    return;
  }

  // Check if fully ready (authenticated + linked)
  const email = await getAuthenticatedEmail();

  if (email && profile) {
    console.log(dim(`Logged in as ${email} · Linked to ${profile.profile.appId}`));
    return;
  }

  // Authenticated but not linked
  if (email) {
    console.log(dim(`Logged in as ${email}`));
    await link({ skipIfLinked: true });
    return;
  }

  // Not authenticated — full flow
  await login({ showNextSteps: false });
  await link({ skipIfLinked: true });
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

  // Pre-scaffold: detect existing auth libraries
  detectAuthLibraries(ctx.deps);

  console.log();

  if (ctx.existingClerk) {
    console.log(dim(`${ctx.framework.sdk} is already installed.`));
  } else {
    await installSdk(ctx);
  }

  await pull({});
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
    console.log(yellow("Warning: You have uncommitted changes."));
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
  const findings = await scanForIssues(cwd, ctx.framework.dep);
  printOutro(plan, findings);
}
