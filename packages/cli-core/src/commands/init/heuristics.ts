import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { dim, cyan, green, yellow, bold } from "../../lib/color.js";
import { printNextSteps } from "../../lib/next-steps.js";
import { printFindings } from "./scan.js";
import { pmInstallCommand } from "./prompts/index.js";
import { withSpinner } from "../../lib/spinner.js";
import type { Need } from "../../lib/deps.ts";
import type { FileAction, ProjectContext, ScaffoldPlan } from "./frameworks/types.js";
import type { ScanFinding } from "./scan.js";

export type InstallSdkDeps = Need<{ log: "info" | "warn" }>;

export async function installSdk(deps: InstallSdkDeps, ctx: ProjectContext): Promise<void> {
  const addCmd = pmInstallCommand(ctx.packageManager);

  if (Bun.which(pmBinary) === null) {
    deps.log.warn(
      yellow(
        `${pmBinary} is not installed but the project's lockfile suggests it. ` +
          `Install ${pmBinary} or run \`${addCmd} ${ctx.framework.sdk}\` manually with another package manager.`,
      ),
    );
    return;
  }

  deps.log.info(`Installing ${cyan(ctx.framework.sdk)} for ${ctx.framework.name}...`);

  let exitCode: number;
  try {
    const proc = Bun.spawn(addCmd.split(" ").concat(packages), {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    exitCode = await proc.exited;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    deps.log.warn(
      yellow(
        `Failed to spawn ${addCmd}: ${message}. You can install manually: ${addCmd} ${ctx.framework.sdk}`,
      ),
    );
    return;
  }

  if (exitCode !== 0) {
    deps.log.warn(
      yellow(
        `Failed to install ${ctx.framework.sdk}. You can install it manually: ${addCmd} ${ctx.framework.sdk}`,
      ),
    );
  }
}

export async function installDeps(ctx: ProjectContext, packages: string[]): Promise<void> {
  const addCmd = pmInstallCommand(ctx.packageManager);
  await runPmInstall(ctx.cwd, addCmd, packages, packages.map(cyan).join(", "));
}

export async function installSdk(ctx: ProjectContext): Promise<void> {
  const addCmd = pmInstallCommand(ctx.packageManager);
  const installPkg = ctx.framework.sdkInstall ?? ctx.framework.sdk;
  await runPmInstall(
    ctx.cwd,
    addCmd,
    [installPkg],
    `${cyan(ctx.framework.sdk)} for ${ctx.framework.name}`,
    { fromLockfile: true },
  );
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

export type PrintOutroDeps = Need<{ log: "info" }>;

export function printOutro(
  deps: PrintOutroDeps,
  plan: ScaffoldPlan,
  findings: ScanFinding[],
): void {
  deps.log.info(bold(green("\n✓ Clerk has been set up in your project\n")));

  for (const action of plan.actions) {
    deps.log.info(formatAction(action));
  }

  printNextSteps(plan.postInstructions);
  printFindings(findings);
  deps.log.info("");
}

export type GetAuthenticatedEmailDeps = Need<{
  credentialStore: "getToken";
  tokenExchange: "fetchUserInfo";
}>;

/**
 * Try to get the currently authenticated user's email without triggering login.
 * Returns null if not authenticated or token is expired.
 */
export async function getAuthenticatedEmail(
  deps: GetAuthenticatedEmailDeps,
): Promise<string | null> {
  try {
    const token = await deps.credentialStore.getToken();
    if (!token) return null;
    const userInfo = await deps.tokenExchange.fetchUserInfo(token);
    return userInfo.email;
  } catch {
    return null;
  }
}

export type PrintKeylessInfoDeps = Need<{ log: "info" }>;

export function printKeylessInfo(deps: PrintKeylessInfoDeps): void {
  const lines = [
    "\n  Your app will work immediately — Clerk generates temporary dev keys automatically.",
    `  Look for the ${bold('"Configure your application"')} banner to claim your account.\n`,
    "  To connect a Clerk account later:",
    "    clerk auth login",
    "    clerk link",
    "    clerk env pull",
  ];
  deps.log.info(lines.map(dim).join("\n"));
}
