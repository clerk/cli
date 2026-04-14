import { isHuman } from "../../mode.ts";
import { green, cyan, yellow } from "../../lib/color.ts";
import { CliError } from "../../lib/errors.ts";
import { detectInstaller, globalInstallCommand, type Installer } from "../../lib/installer.ts";
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

async function findShadowingBinary(installedBinPath: string): Promise<string | null> {
  try {
    const pathDirs = (process.env.PATH ?? "").split(":");
    for (const dir of pathDirs) {
      if (!dir) continue;
      const candidate = `${dir}/${UPDATE_PACKAGE_NAME}`;
      if (candidate === installedBinPath) break;
      const file = Bun.file(candidate);
      if (!(await file.exists())) continue;
      // Skip shell-script shims (asdf, volta, etc.) — only flag native binaries.
      const bytes = new Uint8Array(await file.slice(0, 2).arrayBuffer());
      if (bytes[0] === 0x23 && bytes[1] === 0x21) continue; // "#!"
      return candidate;
    }
    return null;
  } catch {
    return null;
  }
}

async function removeShadowingBinary(shadowPath: string, autoConfirm: boolean): Promise<void> {
  log.blank();
  log.warn(
    `Found an older \`clerk\` binary at \`${shadowPath}\` that takes precedence over the installed one.`,
  );
  log.info("  This can cause the wrong version to run after an update.");
  log.blank();

  const shouldRemove =
    autoConfirm ||
    (isHuman() &&
      (await (async () => {
        const { confirm } = await import("@inquirer/prompts");
        return confirm({ message: `Remove ${shadowPath}?`, default: true });
      })()));

  if (!shouldRemove) {
    log.info(`  Skipped. To remove it manually: ${cyan(`rm ${shadowPath}`)}`);
    return;
  }

  const rm = await Bun.$`rm ${shadowPath}`.quiet().nothrow();
  if (rm.exitCode === 0) {
    log.success(`Removed ${yellow(shadowPath)}`);
  } else {
    const stderr = rm.stderr.toString();
    if (stderr.includes("Permission denied") || stderr.includes("EACCES")) {
      log.warn(`Permission denied. Remove it manually: ${cyan(`sudo rm ${shadowPath}`)}`);
    } else {
      log.warn(`Could not remove ${shadowPath}: ${stderr.trim() || "unknown error"}`);
    }
  }
}

async function runGlobalInstall(installer: Installer, packageSpec: string): Promise<void> {
  let result;
  switch (installer) {
    case "bun":
      result = await Bun.$`bun add -g ${packageSpec}`.quiet().nothrow();
      break;
    case "pnpm":
      result = await Bun.$`pnpm add -g ${packageSpec}`.quiet().nothrow();
      break;
    case "yarn":
      result = await Bun.$`yarn global add ${packageSpec}`.quiet().nothrow();
      break;
    default:
      result = await Bun.$`npm install -g ${packageSpec}`.quiet().nothrow();
      break;
  }
  if (result.exitCode === 0) return;

  const stderr = result.stderr.toString();
  const hint = globalInstallCommand(installer, packageSpec);
  if (stderr.includes("EACCES") || stderr.includes("permission denied")) {
    throw new CliError(`Permission denied. Try: sudo ${hint}`);
  }
  if (result.exitCode === 127 || stderr.includes("not found")) {
    throw new CliError(`${installer} not found on PATH.`);
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

  // Detect installer in parallel with the version check
  const [latest, { installer, binPath }] = await Promise.all([
    withSpinner("Checking for updates...", () => fetchLatestVersion(channel)).catch(() => {
      throw new CliError("Could not reach npm registry. Check your network connection.");
    }),
    detectInstaller(),
  ]);

  if (compareSemver(latest, currentVersion) <= 0) {
    log.info(`${green("✓")} Already on latest (${currentVersion})`);
    if (installer !== "homebrew" && binPath) {
      const shadowPath = await findShadowingBinary(binPath);
      if (shadowPath) await removeShadowingBinary(shadowPath, options.yes || !isHuman());
    }
    if (isHuman()) outro("Up to date");
    return;
  }

  log.info(`  Current: ${currentVersion}`);
  log.info(`  Latest:  ${cyan(latest)}${formatChannelLabel(channel)}`);
  log.blank();

  // Homebrew: cannot auto-update — instruct the user instead
  if (installer === "homebrew") {
    log.info(`  Installed via Homebrew. To update, run:`);
    log.info(`  ${cyan("brew upgrade clerk")}`);
    log.blank();
    if (isHuman()) outro("Run `brew upgrade clerk` to update");
    return;
  }

  const autoConfirm = options.yes || !isHuman();
  const shouldInstall = autoConfirm || (await confirmUpdate(currentVersion, latest));

  if (!shouldInstall) {
    if (isHuman()) outro("Update cancelled");
    return;
  }

  const packageSpec = `${UPDATE_PACKAGE_NAME}@${latest}`;

  await withSpinner(
    `Installing ${packageSpec}...`,
    () => runGlobalInstall(installer, packageSpec),
    `Updated to ${latest}`,
  );

  await writeUpdateCache({ checkedAt: Date.now(), latest, distTag: channel });

  if (binPath) {
    const shadowPath = await findShadowingBinary(binPath);
    if (shadowPath) {
      await removeShadowingBinary(shadowPath, autoConfirm);
    }
  }

  if (isHuman()) outro(`Successfully updated to ${latest}`);
}
