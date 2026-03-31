import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { dim, cyan, green, yellow, bold } from "../../lib/color.js";
import { printNextSteps } from "../../lib/next-steps.js";
import { getToken } from "../../lib/credential-store.js";
import { fetchUserInfo } from "../../lib/token-exchange.js";
import { printFindings } from "./scan.js";
import { pmInstallCommand } from "./prompts/index.js";
import type { ProjectContext, ScaffoldPlan } from "./frameworks/types.js";
import type { ScanFinding } from "./scan.js";

export async function installSdk(ctx: ProjectContext): Promise<void> {
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

export async function writePlan(cwd: string, plan: ScaffoldPlan): Promise<string[]> {
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

export async function checkGitDirty(cwd: string): Promise<boolean> {
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

export function printOutro(plan: ScaffoldPlan, findings: ScanFinding[]): void {
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

  printNextSteps(plan.postInstructions);

  printFindings(findings);

  console.log();
}

/**
 * Try to get the currently authenticated user's email without triggering login.
 * Returns null if not authenticated or token is expired.
 */
export async function getAuthenticatedEmail(): Promise<string | null> {
  try {
    const token = await getToken();
    if (!token) return null;
    const userInfo = await fetchUserInfo(token);
    return userInfo.email;
  } catch {
    return null;
  }
}

export function printKeylessInfo(): void {
  console.log(
    dim("\n  Your app will work immediately — Clerk generates temporary dev keys automatically."),
  );
  console.log(
    dim(`  Look for the ${bold('"Configure your application"')} banner to claim your account.\n`),
  );
  console.log(dim("  To connect a Clerk account later:"));
  console.log(dim("    clerk auth login"));
  console.log(dim("    clerk link"));
  console.log(dim("    clerk env pull"));
}
