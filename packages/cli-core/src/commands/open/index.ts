import { resolveProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { getDashboardUrl } from "../../lib/environment.ts";
import { openBrowser } from "../../lib/browser.ts";
import { isAgent } from "../../mode.ts";

interface OpenOptions {
  print?: boolean;
}

/**
 * Build the dashboard deep-link URL for the linked app's instance.
 * Exported for tests and reuse.
 */
export function buildDashboardUrl(appId: string, instanceId: string): string {
  const host = getDashboardUrl().replace(/\/$/, "");
  return `${host}/apps/${appId}/instances/${instanceId}`;
}

export async function openDashboard(options: OpenOptions = {}): Promise<void> {
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

  const url = buildDashboardUrl(appId, instanceId);

  console.log(url);

  // In agent mode or when --print is set, just emit the URL.
  // Otherwise, also spawn the browser.
  if (options.print || isAgent()) {
    return;
  }

  openBrowser(url);
}
