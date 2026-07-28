import { createArgument } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { resolveProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { getDashboardUrl } from "../../lib/environment.ts";
import { openBrowser } from "../../lib/open.ts";
import { log } from "../../lib/log.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { resolveKeylessTarget } from "../../lib/keyless-target.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";
import { describeKeylessInstance, findKeylessClaimUrl } from "./keyless-claim.ts";

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
    return openKeylessDashboard(cwd, subpath, options);
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

/**
 * The keyless counterpart to `openDashboard` above. An unclaimed keyless
 * application belongs to no account, so `/apps/{appId}/instances/{instanceId}`
 * doesn't exist for it yet — the one page that does is the one-time claim
 * link. `clerk link` cannot help here (there is nothing in any account to
 * link to), so this path exists precisely so the CLI has *some* answer
 * instead of dead-ending on that advice.
 */
async function openKeylessDashboard(
  cwd: string,
  subpath: string | undefined,
  options: OpenOptions,
): Promise<void> {
  const destination = await findKeylessClaimUrl(cwd);

  if (!destination) {
    // A secret key on disk with no claim link is ambiguous: it may be a
    // perfectly claimed app's key set by hand (in which case `clerk link`
    // really is the fix), or a keyless app whose breadcrumb got lost. Name
    // both possibilities rather than guessing.
    const keyless = await resolveKeylessTarget({ cwd });
    if (keyless) {
      throw new CliError(
        `Found a secret key (from ${keyless.source}) but no claim link on disk, so there's no dashboard page to open yet. ` +
          "If this key belongs to an application you've already claimed, run `clerk link` (or pass `--app <app_id>`) to target it directly. " +
          "Otherwise, run `clerk init --keyless` to regenerate a claim link.",
        { code: ERROR_CODE.NOT_LINKED },
      );
    }

    throw new CliError(
      "No Clerk project linked to this directory, and no keyless application was found either. " +
        "Run `clerk link` if you already have an application, or `clerk init` to create one.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  if (subpath) {
    throw new CliError(
      `"${subpath}" isn't reachable yet — this application hasn't been claimed, so it has no dashboard pages beyond the claim link. ` +
        "Run `clerk open` (no subpath) to claim it, then retry the subpath once it's linked.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  const { url, source } = destination;

  // Best-effort only: the claim link is already fully formed, so a bad or
  // missing secret key shouldn't block opening it — it just means the
  // output won't include instance details.
  const instance = await resolveKeylessTarget({ cwd })
    .then((keyless) => (keyless ? describeKeylessInstance(keyless.secretKey) : null))
    .catch(() => null);

  // Output strategy mirrors the linked-app flow above:
  //   --print → plain URL on stdout (scriptable)
  //   agent mode → JSON object with full context (parseable)
  //   human mode → intro/outro logging flow with browser open
  if (options.print) {
    log.data(url);
    return;
  }

  if (isAgent()) {
    log.data(
      JSON.stringify({
        url,
        keyless: true,
        claimSource: source,
        instanceId: instance?.instanceId ?? null,
        environmentType: instance?.environmentType ?? null,
        subpath: null,
        opened: false,
      }),
    );
    return;
  }

  intro("Opening dashboard");

  const suffix = instance?.instanceId ? ` (${instance.instanceId})` : "";
  log.info(`↗ This application hasn't been claimed yet — opening its claim link${suffix}`);
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
    .setExamples([
      { command: "clerk open", description: "Open the linked app's dashboard" },
      { command: "clerk open users", description: "Open the users page" },
      { command: "clerk open api-keys", description: "Open the API keys page" },
      { command: "clerk open --print", description: "Print the dashboard URL" },
    ])
    .action((subpath, options) => openDashboard(subpath, options));
}
