import { createArgument } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { resolveProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { buildDashboardUrl } from "../../lib/environment.ts";
import { openBrowser } from "../../lib/open.ts";
import { log } from "../../lib/log.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { resolveKeylessTarget } from "../../lib/keyless-target.ts";
import {
  appInNoAccount,
  readUnlinkedFolder,
  unlinkedFolderError,
} from "../../lib/unlinked-folder.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";
import { describeKeylessInstance, findKeylessClaimUrl } from "./keyless-claim.ts";

interface OpenOptions {
  print?: boolean;
}

// Re-exported for existing importers; the implementation lives in
// lib/environment.ts next to the host resolution it depends on.
export { buildDashboardUrl };

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

  await outro();
}

/**
 * `clerk open` in a folder with no linked app. An app in no account has no
 * `/apps/{appId}/instances/{instanceId}` page, so this opens its one-time claim
 * link, from the init token or the SDK keyless file.
 */
async function openKeylessDashboard(
  cwd: string,
  subpath: string | undefined,
  options: OpenOptions,
): Promise<void> {
  const destination = await findKeylessClaimUrl(cwd);

  if (!destination) {
    // A key with no claim link may belong to an app already in an account.
    // Never advise `clerk init --accountless`: it creates a new app and
    // overwrites the folder's keys.
    const keyless = await resolveKeylessTarget({ cwd });
    const folder = await readUnlinkedFolder(cwd);
    let lead =
      "No Clerk project linked to this directory, and no accountless application was found either.";
    if (keyless) {
      const found = `Found a secret key (from ${keyless.source}) but no claim link on disk`;
      lead = appInNoAccount(folder)
        ? `${found}, so there's no dashboard page to open yet.`
        : `${found}, and this folder isn't linked, so there's no dashboard page to open.`;
    }
    throw unlinkedFolderError(folder, { lead });
  }

  if (subpath) {
    // A person runs `clerk open`: an agent's run prints the claim link, which
    // carries a claim token, into its transcript.
    const claim = isAgent()
      ? "Have a person claim it: they run `clerk open` (no subpath) in their own terminal, which opens the claim page in their browser. Then retry the subpath once it's linked."
      : "Run `clerk open` (no subpath) to claim it, then retry the subpath once it's linked.";
    throw new CliError(
      `"${subpath}" isn't reachable yet — this application hasn't been claimed, so it has no dashboard pages beyond the claim link. ${claim}`,
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  const { url, source } = destination;

  // Best-effort only: the claim link is already fully formed, so a bad or
  // missing secret key shouldn't block opening it — it just means the
  // output won't include instance details.
  const instance = await resolveKeylessTarget({ cwd })
    .then(async (keyless) => (keyless ? describeKeylessInstance(keyless.secretKey) : null))
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
        accountless: true,
        // Deprecated alias of `accountless`, kept for agents that still parse
        // the legacy key.
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

  await outro();
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
    .action(async (subpath, options) => openDashboard(subpath, options));
}
