import { resolveProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { getDashboardUrl } from "../../lib/environment.ts";
import { openBrowser } from "../../lib/open.ts";
import { dim, yellow, bold, cyan } from "../../lib/color.ts";
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

  // Warn on unknown subpaths but don't block — the dashboard route tree
  // changes faster than this CLI ships, and users may know about new paths.
  // Warning goes to stderr so stdout stays parseable.
  if (subpath && !isKnownDashboardPath(subpath)) {
    console.error(
      yellow(
        `Warning: "${subpath}" is not a known dashboard path. Opening anyway — verify the URL.`,
      ),
    );
  }

  const url = buildDashboardUrl(appId, instanceId, subpath);
  const willOpen = !options.print && !isAgent();

  // Output strategy:
  //   --print → plain URL on stdout (scriptable)
  //   agent mode → JSON object with full context (parseable)
  //   human mode → arrow indicator + app/instance label + dim URL, then open
  if (options.print) {
    console.log(url);
  } else if (isAgent()) {
    console.log(
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
  } else {
    const target = subpath ? ` → ${cyan(subpath)}` : "";
    console.log(`↗ Opening ${bold(appLabel)} (${instanceLabel})${target}`);
    console.log(`  ${dim(url)}`);
  }

  if (willOpen) {
    const result = await openBrowser(url);
    if (!result.ok) {
      console.error(
        `\n${yellow("Could not open your browser automatically.")} Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}\n`,
      );
    }
  }
}
