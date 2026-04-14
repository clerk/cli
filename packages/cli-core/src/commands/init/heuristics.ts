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

export type InstallSdkDeps = Need<{ log: "info" | "warn"; system: "which" | "runInherit" }>;

export async function installSdk(deps: InstallSdkDeps, ctx: ProjectContext): Promise<void> {
  const addCmd = pmInstallCommand(ctx.packageManager);

  // The package manager is detected from lockfiles, which can exist without
  // the actual binary being installed (e.g. teammate committed bun.lock, you
  // only have npm). Fail fast with a useful message rather than a raw ENOENT.
  const pmBinary = addCmd.split(" ")[0] ?? addCmd;
  if (deps.system.which(pmBinary) === null) {
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
    exitCode = await deps.system.runInherit(addCmd.split(" ").concat(ctx.framework.sdk), {
      cwd: ctx.cwd,
    });
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

async function runPmInstall(
  cwd: string,
  addCmd: string,
  packages: string[],
  label: string,
  opts: { fromLockfile?: boolean } = {},
): Promise<void> {
  return withSpinner(`Installing ${label}...`, async () => {
    const proc = Bun.spawn([...addCmd.split(" "), ...packages], {
      cwd,
      stdout: "inherit",
      stderr: "inherit",
    });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      const hint = opts.fromLockfile ? " (detected from lockfile)" : "";
      throw new Error(`Failed to install ${label}${hint}`);
    }
  });
}

export async function installDeps(ctx: ProjectContext, packages: string[]): Promise<void> {
  const addCmd = pmInstallCommand(ctx.packageManager);
  await runPmInstall(ctx.cwd, addCmd, packages, packages.map(cyan).join(", "));
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

export type CheckGitDirtyDeps = Need<{ system: "runCapture" }>;

export async function checkGitDirty(deps: CheckGitDirtyDeps, cwd: string): Promise<boolean> {
  try {
    const res = await deps.system.runCapture(["git", "status", "--porcelain"], { cwd });
    return res.stdout.trim().length > 0;
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
