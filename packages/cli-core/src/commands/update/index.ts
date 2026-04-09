import { isHuman } from "../../mode.ts";
import { green, cyan } from "../../lib/color.ts";
import { CliError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { intro, outro, withSpinner } from "../../lib/spinner.ts";
import { UPDATE_PACKAGE_NAME } from "../../lib/constants.ts";
import {
  getCurrentVersion,
  getUpdateChannel,
  fetchLatestVersion,
  compareSemver,
  isDevVersion,
  writeUpdateCache,
  formatChannelLabel,
} from "../../lib/update-check.ts";

export type UpdateOptions = {
  channel?: string;
  yes?: boolean;
};

async function confirmUpdate(currentVersion: string, latestVersion: string): Promise<boolean> {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({
    message: `Update clerk ${currentVersion} → ${latestVersion}?`,
    default: true,
  });
}

async function runNpmInstall(packageSpec: string): Promise<void> {
  const result = await Bun.$`npm install -g ${packageSpec}`.quiet().nothrow();
  if (result.exitCode === 0) return;

  const stderr = result.stderr.toString();
  if (stderr.includes("EACCES") || stderr.includes("permission denied")) {
    throw new CliError(`Permission denied. Try: sudo npm install -g ${packageSpec}`);
  }
  if (result.exitCode === 127 || stderr.includes("not found")) {
    throw new CliError("npm not found on PATH. Install Node.js from https://nodejs.org");
  }
  throw new CliError(`Update failed: ${stderr.trim() || "unknown error"}`);
}

export async function update(options: UpdateOptions): Promise<void> {
  const currentVersion = getCurrentVersion();

  if (isDevVersion(currentVersion)) {
    log.info("Running development build (0.0.0-dev) — update not applicable.");
    return;
  }

  const channel = options.channel ?? getUpdateChannel();

  if (isHuman()) intro("clerk update");

  const latest = await withSpinner("Checking for updates...", () =>
    fetchLatestVersion(channel),
  ).catch(() => {
    throw new CliError("Could not reach npm registry. Check your network connection.");
  });

  if (compareSemver(latest, currentVersion) <= 0) {
    log.info(`${green("✓")} Already on latest (${currentVersion})`);
    if (isHuman()) outro("Up to date");
    return;
  }

  log.info(`  Current: ${currentVersion}`);
  log.info(`  Latest:  ${cyan(latest)}${formatChannelLabel(channel)}`);
  log.blank();

  const autoConfirm = options.yes || !isHuman();
  const shouldInstall = autoConfirm || (await confirmUpdate(currentVersion, latest));

  if (!shouldInstall) {
    if (isHuman()) outro("Update cancelled");
    return;
  }

  const packageSpec = `${UPDATE_PACKAGE_NAME}@${latest}`;

  await withSpinner(
    `Installing ${packageSpec}...`,
    () => runNpmInstall(packageSpec),
    `Updated to ${latest}`,
  );

  await writeUpdateCache({ checkedAt: Date.now(), latest, distTag: channel });

  if (isHuman()) outro(`Successfully updated to ${latest}`);
}
