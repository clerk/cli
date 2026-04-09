import { join, dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { dim, cyan, green, yellow, bold } from "../../lib/color.js";
import { printNextSteps } from "../../lib/next-steps.js";
import { log } from "../../lib/log.js";
import { getValidToken, hasStoredCredentials } from "../../lib/credential-store.js";
import { fetchUserInfo } from "../../lib/token-exchange.js";
import { printFindings } from "./scan.js";
import { pmInstallCommand } from "../../lib/package-manager.js";
import { withSpinner } from "../../lib/spinner.js";
import type { FileAction, ProjectContext, ScaffoldPlan } from "./frameworks/types.js";
import type { ScanFinding } from "./scan.js";

async function runPmInstall(
  cwd: string,
  addCmd: string,
  packages: string[],
  label: string,
  { fromLockfile = false }: { fromLockfile?: boolean } = {},
): Promise<void> {
  const manualCmd = `${addCmd} ${packages.join(" ")}`;

  // The package manager is detected from lockfiles, which can exist without
  // the actual binary being installed (e.g. teammate committed bun.lock, you
  // only have npm). Fail fast with a useful message rather than a raw ENOENT.
  const pmBinary = addCmd.split(" ")[0];
  if (!pmBinary) {
    throw new Error(`Invalid package manager install command: ${addCmd}`);
  }
  if (Bun.which(pmBinary) === null) {
    const hint = fromLockfile
      ? ` (detected from lockfile — install ${pmBinary} or switch package managers)`
      : "";
    log.warn(`${pmBinary} is not installed${hint}. Install manually: ${manualCmd}`);
    return;
  }

  log.info(`Installing ${label}...`);

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
    log.warn(`Failed to spawn ${addCmd}: ${message}. Install manually: ${manualCmd}`);
    return;
  }

  if (exitCode !== 0) {
    log.warn(`Failed to install ${packages.join(", ")}. Install manually: ${manualCmd}`);
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

export function printOutro(plan: ScaffoldPlan, findings: ScanFinding[]): void {
  log.info(bold(green("\n✓ Clerk has been set up in your project\n")));

  for (const action of plan.actions) {
    log.info(formatAction(action));
  }

  printNextSteps(plan.postInstructions);
  printFindings(findings);
  log.blank();
}

/**
 * Try to get the currently authenticated user's email without triggering login.
 * Returns null if not authenticated or token is expired.
 */
export async function getAuthenticatedEmail(): Promise<string | null> {
  try {
    const token = await getValidToken();
    if (!token) return null;
    const userInfo = await fetchUserInfo(token);
    return userInfo.email;
  } catch {
    return null;
  }
}

/**
 * True if the user has any form of credentials configured locally — either a
 * stored OAuth token or a `CLERK_PLATFORM_API_KEY` env var. Used to pick
 * between the authenticated and keyless flows in `clerk init`.
 *
 * This is a pure credential-presence check: it does not hit the network, so
 * an expired token or a Clerk API outage won't silently demote the user into
 * keyless. Token validity is resolved later by the actual auth/link/pull
 * calls, which surface real errors instead of swallowing them.
 */
export async function isAuthenticated(): Promise<boolean> {
  if (process.env.CLERK_PLATFORM_API_KEY) return true;
  return hasStoredCredentials();
}

export function printKeylessInfo(envFile: string): void {
  const lines = [
    `\n  Your app is ready with development keys in ${envFile}.`,
    `  When you're ready, run ${bold("clerk auth login")} and your app will be claimed automatically.\n`,
  ];
  log.info(lines.map(dim).join("\n"));
}
