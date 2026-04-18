import { isAgent, isHuman } from "../../mode.ts";
import { green, cyan, yellow, dim } from "../../lib/color.ts";
import { CliError } from "../../lib/errors.ts";
import {
  asdfPluginFromPath,
  asdfReshim,
  findClerkOnPath,
  getInstallerPackageDirs,
  globalInstallCommand,
  ownerOfBinary,
  resolveAsdfShim,
  type Installer,
} from "../../lib/installer.ts";
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
  all?: boolean;
};

// ── Target resolution ────────────────────────────────────────────────────────

type Target = {
  /** Path as it appears on PATH (shown to the user). */
  displayPath: string;
  /** Underlying binary after asdf-shim resolution; equal to displayPath for non-shim targets. */
  resolvedPath: string;
  owner: Installer | null;
};

async function resolveTargets(
  runningPath: string,
  installDirs: Awaited<ReturnType<typeof getInstallerPackageDirs>>,
): Promise<{ primary: Target; others: Target[] }> {
  const onPath = await findClerkOnPath();

  const resolved = await Promise.all(onPath.map((p) => resolveAsdfShim(p)));
  const candidates = onPath.map((displayPath, i) => ({
    displayPath,
    resolvedPath: resolved[i]!,
  }));

  // Dedupe by resolvedPath: a shim and its resolved target shouldn't both appear.
  const seen = new Set<string>();
  const unique: Array<{ displayPath: string; resolvedPath: string }> = [];
  for (const c of candidates) {
    if (seen.has(c.resolvedPath)) continue;
    seen.add(c.resolvedPath);
    unique.push(c);
  }

  // Fallback when PATH discovery yields nothing: use the running binary.
  const effective =
    unique.length > 0 ? unique : [{ displayPath: runningPath, resolvedPath: runningPath }];

  const toTarget = (c: { displayPath: string; resolvedPath: string }): Target => ({
    displayPath: c.displayPath,
    resolvedPath: c.resolvedPath,
    owner: ownerOfBinary(c.resolvedPath, installDirs),
  });

  return {
    primary: toTarget(effective[0]!),
    others: effective.slice(1).map(toTarget),
  };
}

// ── Install execution ────────────────────────────────────────────────────────

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
    case "homebrew":
      result = await Bun.$`brew upgrade ${UPDATE_PACKAGE_NAME}`.quiet().nothrow();
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

// ── Skip predicates ──────────────────────────────────────────────────────────

/** Reason a target cannot be auto-updated (returns null if it can). */
function whyCantUpdate(target: Target, channel: string): string | null {
  if (target.owner === null) {
    return "unknown installer (not a package-manager-owned binary)";
  }
  if (target.owner === "homebrew" && channel !== "latest") {
    return `Homebrew has no ${channel} tap; update only works on the stable channel`;
  }
  return null;
}

// ── User-facing reporting ────────────────────────────────────────────────────

function formatTarget(target: Target): string {
  return `${target.displayPath} ${dim(`(${target.owner ?? "unknown"})`)}`;
}

function reportOtherInstalls(others: Target[], channel: string): void {
  if (others.length === 0) return;
  log.blank();
  log.info(`Also found ${others.length} other clerk install${others.length === 1 ? "" : "s"}:`);
  for (const t of others) {
    const skip = whyCantUpdate(t, channel);
    const suffix = skip ? ` ${yellow(`- ${skip}`)}` : "";
    log.info(`  ${formatTarget(t)}${suffix}`);
  }
  log.info(`Run ${cyan("clerk update --all")} to update them too.`);
}

/** Hint for invalidating the current shell's command-hash cache after update. */
function hashHint(): string | null {
  // Windows shells (cmd.exe, PowerShell) don't cache command paths, and `$SHELL`
  // is typically unset — don't emit a POSIX hint in that case.
  if (process.platform === "win32") return null;
  const shell = (process.env.SHELL ?? "").toLowerCase();
  if (shell.endsWith("/fish") || shell.endsWith("fish.exe")) return null; // auto-rehashes
  if (shell.endsWith("/pwsh") || shell.endsWith("powershell.exe")) return null; // no cache
  if (shell.endsWith("/tcsh") || shell.endsWith("/csh")) {
    return "If `clerk` still points to the old binary, run `rehash` or open a new shell.";
  }
  // bash, zsh, sh, dash, ksh all support `hash -r`.
  return "If `clerk` still points to the old binary, run `hash -r` or open a new shell.";
}

/**
 * Detect invocation via a package runner (npx/bunx/pnpm dlx). The binary lives
 * in a runner cache (e.g. `~/.npm/_npx/<hash>/...`) not on PATH, so `ownerOfBinary`
 * can't identify it — but we can recognize the runner from env vars it sets.
 */
function detectPackageRunner(): "npx" | "bunx" | null {
  const ua = (process.env.npm_config_user_agent ?? "").toLowerCase();
  const execPath = (process.env.npm_execpath ?? "").toLowerCase();
  if (execPath.includes("npx") || ua.startsWith("npm/")) return "npx";
  if (ua.startsWith("bun/")) return "bunx";
  return null;
}

// ── Confirmation ─────────────────────────────────────────────────────────────

async function confirmUpdate(currentVersion: string, latestVersion: string): Promise<boolean> {
  const { confirm } = await import("@inquirer/prompts");
  return confirm({
    message: `Update clerk ${currentVersion} → ${latestVersion}?`,
    default: true,
  });
}

// ── Main ─────────────────────────────────────────────────────────────────────

export async function update(options: UpdateOptions): Promise<void> {
  const currentVersion = getCurrentVersion();

  if (isDevVersion(currentVersion)) {
    log.info("Running development build (0.0.0-dev); update not applicable.");
    return;
  }

  const channel = options.channel ?? getUpdateChannel();

  if (isHuman()) intro("clerk update");

  const [latest, installDirs] = await Promise.all([
    withSpinner("Checking for updates...", () => fetchLatestVersion(channel)).catch(() => {
      throw new CliError("Could not reach npm registry. Check your network connection.");
    }),
    getInstallerPackageDirs(),
  ]);

  const { primary, others } = await resolveTargets(process.execPath, installDirs);

  if (compareSemver(latest, currentVersion) <= 0) {
    log.info(`${green("✓")} Already on latest (${currentVersion})`);
    reportOtherInstalls(others, channel);
    if (isHuman()) outro("Up to date");
    return;
  }

  log.info(`  Current: ${currentVersion}`);
  log.info(`  Latest:  ${cyan(latest)}${formatChannelLabel(channel)}`);
  log.info(`  Target:  ${formatTarget(primary)}`);
  log.blank();

  // Primary target can't be updated by us: refuse (don't guess a different installer).
  const primarySkip = whyCantUpdate(primary, channel);
  if (primarySkip) {
    const runner = detectPackageRunner();
    if (primary.owner === null && runner) {
      // npx/bunx runs land in a runner cache that isn't on PATH. There's
      // nothing to "update" in place — the user needs a global install.
      log.warn(`Running via ${runner}; no installed clerk to update. Install globally first:`);
      log.info(`    ${cyan(`bun add -g ${UPDATE_PACKAGE_NAME}@${latest}`)}`);
      log.info(`    ${cyan(`npm install -g ${UPDATE_PACKAGE_NAME}@${latest}`)}`);
    } else {
      log.warn(`Cannot auto-update: ${primarySkip}`);
      if (primary.owner === "homebrew") {
        log.info(`  Run: ${cyan("brew upgrade clerk")}`);
      } else if (primary.owner === null) {
        log.info(`  This binary appears to be installed outside any known package manager.`);
        log.info(`  Reinstall via your preferred method, e.g.:`);
        log.info(`    ${cyan(`bun add -g ${UPDATE_PACKAGE_NAME}@${latest}`)}`);
        log.info(`    ${cyan(`npm install -g ${UPDATE_PACKAGE_NAME}@${latest}`)}`);
        log.info(
          `    ${cyan(`curl -fsSL https://raw.githubusercontent.com/clerk/cli/main/install.sh | bash`)}`,
        );
      }
    }
    reportOtherInstalls(others, channel);
    if (isHuman()) outro("Update required manual action");
    return;
  }

  // In agent/non-interactive mode, require explicit `--yes` rather than silently
  // running a global install the caller didn't confirm.
  if (isAgent() && !options.yes) {
    log.info(`Run \`clerk update --yes\` to proceed.`);
    return;
  }

  const shouldInstall = options.yes || (await confirmUpdate(currentVersion, latest));

  if (!shouldInstall) {
    if (isHuman()) outro("Update cancelled");
    return;
  }

  const packageSpec = `${UPDATE_PACKAGE_NAME}@${latest}`;

  // Build the target list: always primary first, optionally every other updatable install.
  const toUpdate: Target[] = [primary];
  if (options.all) {
    for (const t of others) {
      if (whyCantUpdate(t, channel) === null) toUpdate.push(t);
    }
  }

  const results: Array<{ target: Target; ok: boolean; error?: string }> = [];
  for (const t of toUpdate) {
    // `owner` is non-null here because whyCantUpdate returned null for it.
    const owner = t.owner as Installer;
    try {
      await withSpinner(
        `Installing ${packageSpec} via ${owner} (${t.displayPath})...`,
        () => runGlobalInstall(owner, packageSpec),
        `Updated ${owner}: ${t.displayPath}`,
      );
      results.push({ target: t, ok: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ target: t, ok: false, error: message });
      // Keep going for --all; a single failure shouldn't block other installs.
      if (!options.all) throw error;
    }
  }

  // Safety net: modern asdf-nodejs auto-reshims on npm install, older ones don't.
  const asdfPlugins = new Set<string>();
  for (const r of results) {
    if (!r.ok) continue;
    const plugin = asdfPluginFromPath(r.target.resolvedPath);
    if (plugin) asdfPlugins.add(plugin);
  }
  for (const plugin of asdfPlugins) {
    await asdfReshim(plugin);
  }

  // Only refresh the update-notification cache when every attempted install
  // succeeded — otherwise a partial --all failure would silently mark the
  // latest version as cached.
  const anyFailed = results.some((r) => !r.ok);
  if (!anyFailed) {
    await writeUpdateCache({ checkedAt: Date.now(), latest, distTag: channel });
  }

  // Summary + skipped installs when --all.
  if (options.all) {
    log.blank();
    log.info("Summary:");
    for (const r of results) {
      const icon = r.ok ? green("✓") : yellow("✗");
      const primaryTag = r.target === primary ? dim(" [primary]") : "";
      const suffix = r.ok ? "" : ` ${yellow(`- ${r.error}`)}`;
      log.info(`  ${icon} ${formatTarget(r.target)}${primaryTag}${suffix}`);
    }
    for (const t of others) {
      const skip = whyCantUpdate(t, channel);
      if (!skip) continue;
      log.info(`  ${yellow("⚠")} ${formatTarget(t)} ${yellow(`- skipped: ${skip}`)}`);
    }
  } else {
    reportOtherInstalls(others, channel);
  }

  const hint = hashHint();
  if (hint) {
    log.blank();
    log.info(hint);
  }

  if (isHuman()) {
    outro(anyFailed ? "Update completed with errors" : `Successfully updated to ${latest}`);
  }
}
