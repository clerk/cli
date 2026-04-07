import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { dim, cyan, green, yellow, bold } from "../../lib/color.js";
import { printNextSteps } from "../../lib/next-steps.js";
import { getToken } from "../../lib/credential-store.js";
import { fetchUserInfo } from "../../lib/token-exchange.js";
import { printFindings } from "./scan.js";
import { pmInstallCommand } from "./prompts/index.js";
import { withSpinner } from "../../lib/spinner.js";
import type { FileAction, ProjectContext, ScaffoldPlan } from "./frameworks/types.js";
import type { ScanFinding } from "./scan.js";

export async function installSdk(ctx: ProjectContext): Promise<void> {
  const addCmd = pmInstallCommand(ctx.packageManager);

  // The package manager is detected from lockfiles, which can exist without
  // the actual binary being installed (e.g. teammate committed bun.lock, you
  // only have npm). Fail fast with a useful message rather than a raw ENOENT.
  const pmBinary = addCmd.split(" ")[0];
  if (Bun.which(pmBinary) === null) {
    console.log(
      yellow(
        `${pmBinary} is not installed but the project's lockfile suggests it. ` +
          `Install ${pmBinary} or run \`${addCmd} ${ctx.framework.sdk}\` manually with another package manager.`,
      ),
    );
    return;
  }

  console.log(`Installing ${cyan(ctx.framework.sdk)} for ${ctx.framework.name}...`);

  // try/catch covers the TOCTOU window between Bun.which and spawn.
  let exitCode: number;
  try {
    const proc = Bun.spawn(addCmd.split(" ").concat(ctx.framework.sdk), {
      cwd: ctx.cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.log(
      yellow(
        `Failed to spawn ${addCmd}: ${message}. You can install manually: ${addCmd} ${ctx.framework.sdk}`,
      ),
    );
    return;
  }

  if (exitCode !== 0) {
    console.log(
      yellow(
        `Failed to install ${ctx.framework.sdk}. You can install it manually: ${addCmd} ${ctx.framework.sdk}`,
      ),
    );
  }
}

export async function writePlan(cwd: string, plan: ScaffoldPlan): Promise<string[]> {
  return withSpinner("Writing files...", async () => {
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
  });
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

function formatAction(action: FileAction): string {
  if (action.type === "create") return `  ${green("+")} ${action.path}`;
  if (action.type === "modify") return `  ${yellow("~")} ${action.path}`;
  return `  ${dim("-")} ${dim(action.path)} ${dim(`(${action.skipReason})`)}`;
}

export function printOutro(plan: ScaffoldPlan, findings: ScanFinding[]): void {
  console.log(bold(green("\n✓ Clerk has been set up in your project\n")));

  for (const action of plan.actions) {
    console.log(formatAction(action));
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
  const lines = [
    "\n  Your app will work immediately — Clerk generates temporary dev keys automatically.",
    `  Look for the ${bold('"Configure your application"')} banner to claim your account.\n`,
    "  To connect a Clerk account later:",
    "    clerk auth login",
    "    clerk link",
    "    clerk env pull",
  ];
  console.log(lines.map(dim).join("\n"));
}
