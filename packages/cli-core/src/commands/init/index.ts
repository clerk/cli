import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { login } from "../auth/login.js";
import { link } from "../link/index.js";
import { pull } from "../env/pull.js";
import { isAgent } from "../../mode.js";
import { dim, cyan, green, yellow, bold } from "../../lib/color.js";
import { CliError, throwUserAbort } from "../../lib/errors.js";
import { lookupFramework, FRAMEWORK_NAMES } from "../../lib/framework.js";
import { getToken } from "../../lib/credential-store.js";
import { resolveProfile } from "../../lib/config.js";
import { fetchUserInfo } from "../../lib/token-exchange.js";
import { gatherContext } from "./context.js";
import { scaffold, enrichProjectContext } from "./scaffold.js";
import { previewPlan, previewAndConfirm } from "./preview.js";
import { runFormatters } from "./format.js";
import { detectAuthLibraries, scanForIssues, printFindings } from "./scan.js";
import { buildAgentPrompt, GENERIC_AGENT_PROMPT, pmInstallCommand } from "./prompts/index.js";
import type { ProjectContext, ScaffoldPlan } from "./frameworks/types.js";
import type { ScanFinding } from "./scan.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function installSdk(ctx: ProjectContext): Promise<void> {
  const addCmd = pmInstallCommand(ctx.packageManager);
  console.log(`Installing ${cyan(ctx.framework.sdk)} for ${ctx.framework.name}...`);

  const proc = Bun.spawn(addCmd.split(" ").concat(ctx.framework.sdk), {
    cwd: ctx.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const exitCode = await proc.exited;

  if (exitCode !== 0) {
    console.log(
      yellow(
        `Failed to install ${ctx.framework.sdk}. You can install it manually: ${addCmd} ${ctx.framework.sdk}`,
      ),
    );
  }
}

async function writePlan(cwd: string, plan: ScaffoldPlan): Promise<string[]> {
  const written: string[] = [];

  for (const action of plan.actions) {
    if (action.type === "skip") continue;

    const fullPath = join(cwd, action.path);

    if (action.type === "create") {
      await mkdir(dirname(fullPath), { recursive: true });
    }

    await Bun.write(fullPath, action.content);
    written.push(action.path);
  }

  return written;
}

async function checkGitDirty(cwd: string): Promise<boolean> {
  try {
    const proc = Bun.spawn(["git", "status", "--porcelain"], {
      cwd,
      stdout: "pipe",
      stderr: "ignore",
    });
    const output = await new Response(proc.stdout).text();
    await proc.exited;
    return output.trim().length > 0;
  } catch {
    return false;
  }
}

function printOutro(plan: ScaffoldPlan, findings: ScanFinding[]): void {
  const created = plan.actions.filter((a) => a.type === "create");
  const modified = plan.actions.filter((a) => a.type === "modify");
  const skipped = plan.actions.filter((a) => a.type === "skip");

  console.log(bold(green("\n✓ Clerk has been set up in your project!\n")));

  for (const a of created) {
    console.log(`  ${green("+")} ${a.path}`);
  }
  for (const a of modified) {
    console.log(`  ${yellow("~")} ${a.path}`);
  }
  for (const a of skipped) {
    console.log(`  ${dim("-")} ${dim(a.path)} ${dim(`(${a.skipReason})`)}`);
  }

  if (plan.postInstructions.length > 0) {
    console.log(dim("\nNext steps:"));
    for (const instr of plan.postInstructions) {
      console.log(dim(`  • ${instr}`));
    }
  }

  printFindings(findings);

  console.log();
}

/**
 * Try to get the currently authenticated user's email without triggering login.
 * Returns null if not authenticated or token is expired.
 */
async function getAuthenticatedEmail(): Promise<string | null> {
  try {
    const token = await getToken();
    if (!token) return null;
    const userInfo = await fetchUserInfo(token);
    return userInfo.email;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

interface InitOptions {
  framework?: string;
  yes?: boolean;
  prompt?: boolean;
}

export async function init(options: InitOptions = {}) {
  const cwd = process.cwd();

  // Resolve --framework override
  let frameworkOverride;
  if (options.framework) {
    frameworkOverride = lookupFramework(options.framework);
    if (!frameworkOverride) {
      throw new CliError(
        `Unknown framework "${options.framework}". Valid values: ${FRAMEWORK_NAMES.join(", ")}`,
      );
    }
  }

  const ctx = await gatherContext(cwd, frameworkOverride);

  // Populate framework-specific context (variant, layoutPath, middlewareBasename)
  if (ctx) await enrichProjectContext(ctx);

  if (options.prompt || isAgent()) {
    console.log(ctx ? buildAgentPrompt(ctx) : GENERIC_AGENT_PROMPT);
    return;
  }

  await authenticateAndLink(cwd);
  await detectAndInstall(cwd, ctx, options);
}

async function authenticateAndLink(cwd: string): Promise<void> {
  // Check if fully ready (authenticated + linked)
  const email = await getAuthenticatedEmail();
  const profile = await resolveProfile(cwd);

  if (email && profile) {
    console.log(dim(`Logged in as ${email} · Linked to ${profile.profile.appId}`));
    return;
  }

  // Authenticated but not linked — skip login, just link
  if (email) {
    console.log(dim(`Logged in as ${email}`));
    await link({ skipIfLinked: true });
    return;
  }

  // Not authenticated — full flow
  await login();
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
