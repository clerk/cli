import { createArgument } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { resolveAppContext, resolveProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { getDashboardUrl } from "../../lib/environment.ts";
import { openBrowser } from "../../lib/open.ts";
import { log } from "../../lib/log.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";

interface OpenOptions {
  print?: boolean;
  instance?: string;
  branch?: string;
}

/**
 * Build the dashboard deep-link URL for the linked app's instance.
 * Exported for tests and reuse.
 */
export function buildDashboardUrl(appId: string, instanceId: string, subpath?: string): string {
  const host = getDashboardUrl().replace(/\/$/, "");
  const base = `${host}/apps/${appId}/instances/${instanceId}`;
  if (!subpath) return base;
  const cleaned = subpath.replace(/^\//, "").replace(/\/$/, "");
  return cleaned ? `${base}/${cleaned}` : base;
}

export async function openDashboard(
  subpath: string | undefined,
  options: OpenOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const resolved = await resolveProfile(cwd);

  if (!resolved) {
    throw new CliError("No Clerk project linked to this directory. Run `clerk link` first.", {
      code: ERROR_CODE.NOT_LINKED,
    });
  }

  const { appId, appName } = resolved.profile;
  const appLabel = appName || appId;

  // Join the one resolution chain (ADR-0011): explicit --instance/--branch, else
  // the worktree's active pointer, else the development root. `open` no longer
  // hardcodes the dev root, so it opens wherever you are actually working.
  const ctx = await resolveAppContext({ instance: options.instance, branch: options.branch, cwd });
  const instanceId = ctx.instanceId;
  const instanceLabel = ctx.instanceLabel;

  if (!instanceId) {
    throw new CliError(
      "No development instance configured for this project. Run `clerk link` to set one up.",
      { code: ERROR_CODE.INSTANCE_NOT_FOUND },
    );
  }

  const url = buildDashboardUrl(appId, instanceId, subpath);
  const unknownPath = subpath && !isKnownDashboardPath(subpath);

  // Output strategy:
  //   --print → plain URL on stdout (scriptable)
  //   agent mode → JSON object with full context (parseable)
  //   human mode → intro/outro logging flow with browser open
  if (options.print) {
    if (unknownPath) {
      log.warn(`"${subpath}" is not a known dashboard path. Opening anyway — verify the URL.`);
    }
    log.data(url);
    return;
  }

  if (isAgent()) {
    if (unknownPath) {
      log.warn(`"${subpath}" is not a known dashboard path. Opening anyway — verify the URL.`);
    }
    log.data(
      JSON.stringify({
        url,
        appId,
        appName: appName ?? null,
        instanceId,
        instanceLabel,
        subpath: subpath ?? null,
        opened: false,
      }),
    );
    return;
  }

  // Human mode — use intro/outro logging flow
  const target = subpath ? ` → ${cyan(subpath)}` : "";
  intro("Opening dashboard");

  if (unknownPath) {
    log.warn(`"${subpath}" is not a known dashboard path. Opening anyway — verify the URL.`);
  }

  log.info(`↗ Opening ${bold(appLabel)} (${instanceLabel})${target}`);
  log.info(`  ${dim(url)}`);

  const result = await openBrowser(url);
  if (!result.ok) {
    log.warn(
      `Could not open your browser automatically. Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}`,
    );
  }

  outro();
}

export function registerOpen(program: Program): void {
  const open = program.command("open").description("Open Clerk resources in your browser");

  open
    .command("dashboard", { isDefault: true })
    .description("Open the linked app's dashboard in your browser")
    .addArgument(
      createArgument("[subpath]", "Optional dashboard subpath (e.g. users, api-keys, settings)"),
    )
    .option("--print", "Print the URL without opening the browser")
    .option("--instance <id>", "Instance to open (dev, prod, or a full instance ID)")
    .option("--branch <name>", "Open a branch by name (e.g. agent/pr-42)")
    .setExamples([
      { command: "clerk open", description: "Open the active instance's dashboard" },
      { command: "clerk open users", description: "Open the users page" },
      { command: "clerk open api-keys", description: "Open the API keys page" },
      { command: "clerk open --branch main", description: "Open the main branch's dashboard" },
      { command: "clerk open --print", description: "Print the dashboard URL" },
    ])
    .action((subpath, options) => openDashboard(subpath, options));
}
