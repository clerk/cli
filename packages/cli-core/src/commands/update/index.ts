import type { Program } from "../../cli-program.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { green, cyan, yellow, dim } from "../../lib/color.ts";
import { CliError } from "../../lib/errors.ts";
import {
  asdfPluginFromPath,
  asdfReshim,
  findClerkOnPath,
  findRunningInstallIndex,
  getInstallerPackageDirs,
  globalInstallCommand,
  ownerOfBinary,
  resolveAsdfShim,
  safeRealpath,
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
  const [onPath, runningResolved] = await Promise.all([
    findClerkOnPath(),
    safeRealpath(runningPath),
  ]);

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

  // Promote the install that owns the currently-running binary to primary.
  // The binary the user just invoked is the authoritative update target:
  // shell hash caches (zsh/bash) and PATH ordering quirks (asdf shims before
  // `~/.bun/bin`) can make a fresh PATH walk disagree with what actually ran,
  // leaving `clerk -v` unchanged after an "Updated" message because a
  // different install got the upgrade. When the running binary isn't on PATH
  // (invoked by absolute path, PATH mutated mid-session), fall through to
  // PATH order.
  const runningIdx = findRunningInstallIndex(unique, runningResolved, installDirs);
  const reordered =
    runningIdx > 0
      ? [unique[runningIdx]!, ...unique.slice(0, runningIdx), ...unique.slice(runningIdx + 1)]
      : unique;

  // Fallback when PATH discovery yields nothing: use the running binary.
  // `resolvedPath` gets the realpath'd variant so ownerOfBinary sees the
  // same form (e.g. `/private/var/...` on macOS) that PM install dirs use —
  // otherwise an unresolved `/var/...` execPath would fail owner matching.
  const effective =
    reordered.length > 0
      ? reordered
      : [{ displayPath: runningPath, resolvedPath: runningResolved }];

  log.debug(
    `update: primary=${effective[0]!.resolvedPath} (runningIdx=${runningIdx}, execPath=${runningResolved})`,
  );

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

async function runGlobalInstall(
  installer: Installer,
  packageSpec: string,
  targetVersion: string,
): Promise<void> {
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
  if (result.exitCode !== 0) {
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

  // Homebrew installs whatever version its tap currently publishes, ignoring
  // the packageSpec pin. When the tap lags the npm release, `brew upgrade`
  // exits 0 but leaves the old version in place. Verify post-install and
  // surface the mismatch so the user isn't left with a stale binary believing
  // the update succeeded.
  if (installer === "homebrew") {
    const installed = await installedBrewVersion();
    if (installed && installed !== targetVersion) {
      throw new CliError(
        `Homebrew tap is stale: installed ${installed}, expected ${targetVersion}. ` +
          `Update via another installer (e.g. \`npm install -g ${packageSpec}\`) ` +
          `or wait for the tap to catch up.`,
      );
    }
  }
}

/** Returns the currently installed Homebrew clerk version, or null on failure. */
async function installedBrewVersion(): Promise<string | null> {
  const result = await Bun.$`brew list --versions ${UPDATE_PACKAGE_NAME}`.quiet().nothrow();
  if (result.exitCode !== 0) return null;
  // Output shape: "clerk 0.8.4 0.8.5" (package name + one or more versions).
  // The last token is the most recently installed version that brew will use.
  const tokens = result.stdout.toString().trim().split(/\s+/);
  return tokens.length >= 2 ? (tokens.at(-1) ?? null) : null;
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
  // Windows native shells (cmd.exe, PowerShell) don't cache command paths.
  // On Windows, $SHELL is typically unset, so nothing below would match anyway —
  // but return early to be explicit.
  if (process.platform === "win32") return null;
  const shell = (process.env.SHELL ?? "").toLowerCase();
  if (shell.endsWith("/fish") || process.env.FISH_VERSION) return null; // auto-rehashes
  // pwsh can run on Linux/macOS via $SHELL=/usr/bin/pwsh; no command-hash cache.
  if (shell.endsWith("/pwsh")) return null;
  if (shell.endsWith("/tcsh") || shell.endsWith("/csh")) {
    return "If `clerk` still points to the old binary, run `rehash` or open a new shell.";
  }
  // bash, zsh, sh, dash, ksh all support `hash -r`.
  return "If `clerk` still points to the old binary, run `hash -r` or open a new shell.";
}

/**
 * Detect invocation via a package runner (npx/bunx). The binary lives in a
 * runner cache (e.g. `~/.npm/_npx/<hash>/...`) not on PATH, so `ownerOfBinary`
 * can't identify it.
 *
 * Detection is execpath-only: `npm_config_user_agent` alone is unreliable
 * because it's set for *every* npm/bun invocation (e.g. `npm run build` that
 * internally calls `clerk update` would look like npx). The execpath — the
 * actual binary that launched the process — is the only signal that
 * distinguishes a runner from a regular script invocation.
 */
function detectPackageRunner(): "npx" | "bunx" | null {
  const execPath = (process.env.npm_execpath ?? process.argv0 ?? "").toLowerCase();
  // Match the runner basename, not any substring (so `/home/npxyz/node` doesn't
  // misfire; `_npx/<hash>/…/npx-cli.js` and `…/npx` both end with `npx` after
  // stripping the optional `.js`).
  const stripped = execPath.replace(/\.(js|cjs|mjs|exe|cmd)$/, "");
  if (/(^|[\\/])npx$/.test(stripped) || execPath.includes("/_npx/")) return "npx";
  if (/(^|[\\/])bunx$/.test(stripped)) return "bunx";
  return null;
}

// ── Confirmation ─────────────────────────────────────────────────────────────

async function confirmUpdate(currentVersion: string, latestVersion: string): Promise<boolean> {
  const { confirm } = await import("../../lib/prompts.ts");
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

  if (isHuman()) intro("Checking for updates");

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

  // Build the ordered updatable list. Without --all, only the primary counts;
  // with --all, include every on-PATH install whose owner we can update.
  const primarySkip = whyCantUpdate(primary, channel);
  const toUpdate: Target[] = [];
  if (!primarySkip) toUpdate.push(primary);
  if (options.all) {
    for (const t of others) {
      if (whyCantUpdate(t, channel) === null) toUpdate.push(t);
    }
  }

  // Nothing we can update: emit the refuse-path guidance keyed off the primary
  // (still the most useful target to talk about), then exit. The --all branch
  // shares this exit only when *every* install is blocked, which is the
  // intended refuse behavior.
  if (toUpdate.length === 0) {
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

  // --all with a blocked primary: tell the user before we proceed that we're
  // skipping their shell's effective `clerk` and updating other installs
  // instead. Without this, a user who runs `--all --channel canary` on a
  // Homebrew-primary machine would see no reason their `clerk -v` stays the
  // same until they read the summary.
  if (primarySkip && options.all) {
    log.warn(`Skipping primary (${formatTarget(primary)}): ${primarySkip}`);
    log.info(
      `Proceeding with ${toUpdate.length} other install${toUpdate.length === 1 ? "" : "s"}.`,
    );
    log.blank();
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

  const results: Array<{ target: Target; ok: boolean; error?: string }> = [];
  for (const t of toUpdate) {
    // `owner` is non-null here because whyCantUpdate returned null for it.
    const owner = t.owner as Installer;
    try {
      await withSpinner(
        `Installing ${packageSpec} via ${owner} (${t.displayPath})...`,
        () => runGlobalInstall(owner, packageSpec, latest),
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
    // Skipped installs. Include the primary when it was blocked (so users
    // aren't left wondering why `clerk -v` didn't change after --all).
    if (primarySkip) {
      log.info(
        `  ${yellow("⚠")} ${formatTarget(primary)}${dim(" [primary]")} ${yellow(`- skipped: ${primarySkip}`)}`,
      );
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

export function registerUpdate(program: Program): void {
  program
    .command("update")
    .description("Update the Clerk CLI to the latest version")
    .option("--channel <tag>", "Release channel to update to (e.g. latest, canary)")
    .option("-y, --yes", "Skip confirmation prompt")
    .option("--all", "Update every clerk install found on PATH, not just the first")
    .setExamples([
      { command: "clerk update", description: "Update to the latest stable release" },
      {
        command: "clerk update --channel canary",
        description: "Update to the latest canary release",
      },
      { command: "clerk update --yes", description: "Update without confirmation prompt" },
      { command: "clerk update --all", description: "Update every clerk install on PATH" },
    ])
    .action(update);
}
