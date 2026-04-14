import type { Need } from "../../lib/deps.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";

interface OpenOptions {
  print?: boolean;
}

export type OpenDashboardDeps = Need<{
  configStore: "resolveProfile";
  environment: "getDashboardUrl";
  opener: "open";
  spinner: "intro" | "outro";
  mode: "isAgent";
  log: "info" | "warn" | "data";
}>;

/**
 * Build the dashboard deep-link URL for the linked app's instance.
 * Exported for tests and reuse.
 */
export function buildDashboardUrl(
  host: string,
  appId: string,
  instanceId: string,
  subpath?: string,
): string {
  const trimmed = host.replace(/\/$/, "");
  const base = `${trimmed}/apps/${appId}/instances/${instanceId}`;
  if (!subpath) return base;
  const cleaned = subpath.replace(/^\//, "").replace(/\/$/, "");
  return cleaned ? `${base}/${cleaned}` : base;
}

export async function openDashboard(
  deps: OpenDashboardDeps,
  subpath: string | undefined,
  options: OpenOptions = {},
): Promise<void> {
  const cwd = process.cwd();
  const resolved = await deps.configStore.resolveProfile(cwd);

  if (!resolved) {
    throw new CliError("No Clerk project linked to this directory. Run `clerk link` first.", {
      code: ERROR_CODE.NOT_LINKED,
    });
  }

  const { appId, appName } = resolved.profile;
  const instanceId = resolved.profile.instances.development;
  const instanceLabel = "development";
  const appLabel = appName || appId;

  if (!instanceId) {
    throw new CliError(
      "No development instance configured for this project. Run `clerk link` to set one up.",
      { code: ERROR_CODE.INSTANCE_NOT_FOUND },
    );
  }

  const url = buildDashboardUrl(deps.environment.getDashboardUrl(), appId, instanceId, subpath);
  const unknownPath = subpath && !isKnownDashboardPath(subpath);

  // Output strategy:
  //   --print -> plain URL on stdout (scriptable)
  //   agent mode -> JSON object with full context (parseable)
  //   human mode -> intro/outro logging flow with browser open
  if (options.print) {
    if (unknownPath) {
      deps.log.warn(`"${subpath}" is not a known dashboard path. Opening anyway, verify the URL.`);
    }
    deps.log.data(url);
    return;
  }

  if (deps.mode.isAgent()) {
    if (unknownPath) {
      deps.log.warn(`"${subpath}" is not a known dashboard path. Opening anyway, verify the URL.`);
    }
    deps.log.data(
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

  // Human mode, use intro/outro logging flow
  const target = subpath ? ` → ${cyan(subpath)}` : "";
  deps.spinner.intro("clerk open");

  if (unknownPath) {
    deps.log.warn(`"${subpath}" is not a known dashboard path. Opening anyway, verify the URL.`);
  }

  deps.log.info(`↗ Opening ${bold(appLabel)} (${instanceLabel})${target}`);
  deps.log.info(`  ${dim(url)}`);

  const result = await deps.opener.open(url);
  if (!result.ok) {
    deps.log.warn(
      `Could not open your browser automatically. Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}`,
    );
  }

  deps.spinner.outro();
}
