import { select } from "@inquirer/prompts";
import { login } from "../auth/login.js";
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
import type { ProjectContext } from "./frameworks/types.js";

type AuthMode = "keyless" | "authenticated";

type AuthResolution = {
  mode: AuthMode;
  email: string | null;
};

type InitOptions = {
  framework?: string;
  yes?: boolean;
  prompt?: boolean;
};

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();

  // Commander validates --framework against FRAMEWORK_NAMES choices
  const frameworkOverride = options.framework
    ? (lookupFramework(options.framework) ?? undefined)
    : undefined;
  const ctx = await gatherContext(cwd, frameworkOverride);

  // Populate framework-specific context (variant, layoutPath, middlewareBasename)
  if (ctx) await enrichProjectContext(ctx);

  if (options.prompt || isAgent()) {
    console.log(
      "Run `clerk init -y` to automatically detect the framework, install the Clerk SDK, and scaffold authentication files without interactive prompts.",
    );
    return;
  }

  const { mode, email } = await resolveAuthMode(cwd, options.yes);

  if (mode === "authenticated") {
    await ensureAuthenticated(email);
  }

  await detectAndInstall(cwd, ctx, options, mode);
}

async function resolveAuthMode(cwd: string, yes?: boolean): Promise<AuthResolution> {
  // Platform API key — skip OAuth entirely
  const hasApiKey = Boolean(process.env.CLERK_PLATFORM_API_KEY);

  if (hasApiKey) {
    const profile = await resolveProfile(cwd);
    if (profile) {
      console.log(dim(`Using API key · Linked to ${profile.profile.appId}`));
    }
    return { mode: "authenticated", email: null };
  }

  const email = await getAuthenticatedEmail();

  if (email) {
    const profile = await resolveProfile(cwd);
    const linkedInfo = profile ? ` · Linked to ${profile.profile.appId}` : "";
    console.log(dim(`Logged in as ${email}${linkedInfo}`));
    return { mode: "authenticated", email };
  }

  // Not authenticated + --yes flag: default to keyless (fastest path, no browser)
  if (yes) return { mode: "keyless", email: null };

  const mode = await select<AuthMode>({
    message: "How would you like to set up Clerk?",
    choices: [
      { name: "Continue with temporary keys (connect your account later)", value: "keyless" },
      { name: "Log in to an existing Clerk account", value: "authenticated" },
    ],
  });

  return { mode, email: null };
}

async function ensureAuthenticated(email: string | null): Promise<void> {
  if (!email) {
    await login({ showNextSteps: false });
  }
  await link({ skipIfLinked: true });
}

async function detectAndInstall(
  cwd: string,
  ctx: ProjectContext | null,
  options: InitOptions,
  authMode: AuthMode,
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

  if (authMode === "authenticated") {
    await pull({});
    return;
  }

  printKeylessInfo();
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
