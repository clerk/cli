import { resolveProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { getDashboardUrl } from "../../lib/environment.ts";
import { openBrowser } from "../../lib/browser.ts";
import { yellow } from "../../lib/color.ts";
import { isAgent } from "../../mode.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";

interface OpenOptions {
  print?: boolean;
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

  const { appId } = resolved.profile;
  const instanceId = resolved.profile.instances.development;

  if (!instanceId) {
    throw new CliError(
      "No development instance configured for this project. Run `clerk link` to set one up.",
      { code: ERROR_CODE.INSTANCE_NOT_FOUND },
    );
  }

  // Warn on unknown subpaths but don't block — the dashboard route tree
  // changes faster than this CLI ships, and users may know about new paths.
  if (subpath && !isKnownDashboardPath(subpath)) {
    console.error(
      yellow(
        `Warning: "${subpath}" is not a known dashboard path. Opening anyway — verify the URL.`,
      ),
    );
  }

  const url = buildDashboardUrl(appId, instanceId, subpath);

  console.log(url);

  // In agent mode or when --print is set, just emit the URL.
  // Otherwise, also spawn the browser.
  if (options.print || isAgent()) {
    return;
  }

  openBrowser(url);
}
