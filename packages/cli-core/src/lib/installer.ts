/**
 * Global installer detection.
 *
 * Detects how the CLI was installed globally — npm, bun, pnpm, yarn, or
 * Homebrew — so the update command can use the correct update mechanism.
 *
 * Detection priority:
 *  1. `npm_config_user_agent` env var (set when invoked via a PM script runner)
 *  2. `process.execPath` — the real, symlink-resolved binary path:
 *     a. Contains `/Cellar/clerk/` → Homebrew
 *     b. Matches a PM's global prefix → that PM
 *  3. Falls back to npm
 *
 * This module also provides `globalInstallCommand()` for building
 * user-facing install/update hints.
 */

import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { log } from "./log.ts";
import { UPDATE_PACKAGE_NAME } from "./constants.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** How the CLI was installed globally. */
export type Installer = "npm" | "bun" | "pnpm" | "yarn" | "homebrew";

// ── Stage 1: npm_config_user_agent ───────────────────────────────────────────

export function detectFromUserAgent(): Installer | null {
  const ua = process.env.npm_config_user_agent ?? "";
  if (ua.startsWith("bun/")) return "bun";
  if (ua.startsWith("pnpm/")) return "pnpm";
  if (ua.startsWith("yarn/")) return "yarn";
  if (ua.startsWith("npm/")) return "npm";
  return null;
}

// ── Stage 2a: Homebrew ───────────────────────────────────────────────────────

export function isHomebrewPath(execPath: string): boolean {
  // Matches:
  //   /opt/homebrew/Cellar/clerk/...         (macOS Apple Silicon)
  //   /usr/local/Cellar/clerk/...            (macOS Intel)
  //   /home/linuxbrew/.linuxbrew/Cellar/clerk/... (Linuxbrew)
  return /\/Cellar\/clerk\//.test(execPath);
}

// ── Stage 2b: PM prefix matching ─────────────────────────────────────────────

async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

async function queryPmPrefix(pm: "npm" | "bun" | "pnpm" | "yarn"): Promise<string | null> {
  try {
    let result;
    switch (pm) {
      case "bun":
        result = await Bun.$`bun pm bin -g`.quiet().nothrow();
        break;
      case "pnpm":
        result = await Bun.$`pnpm root -g`.quiet().nothrow();
        break;
      case "yarn":
        result = await Bun.$`yarn global dir`.quiet().nothrow();
        break;
      default: {
        result = await Bun.$`npm prefix -g`.quiet().nothrow();
        if (result.exitCode !== 0) return null;
        const prefix = result.stdout.toString().trim();
        if (!prefix) return null;
        return await safeRealpath(`${prefix}/lib/node_modules`);
      }
    }
    if (result.exitCode !== 0) return null;
    const dir = result.stdout.toString().trim();
    if (!dir) return null;
    return await safeRealpath(dir);
  } catch {
    return null;
  }
}

async function matchPmFromExecPath(execPath: string): Promise<Installer | null> {
  const pms = ["bun", "pnpm", "yarn", "npm"] as const;
  const results = await Promise.allSettled(pms.map((pm) => queryPmPrefix(pm)));

  for (const [i, result] of results.entries()) {
    if (result.status !== "fulfilled" || !result.value) continue;
    const pm = pms[i];
    if (pm && execPath.startsWith(result.value + "/")) return pm;
  }
  return null;
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Detect the installer that installed the CLI globally.
 *
 * Uses `npm_config_user_agent` when available (highest confidence), then
 * inspects `process.execPath` to identify Homebrew or match against PM
 * global directories. `process.execPath` resolves through symlinks
 * automatically, so a symlink at `~/.local/bin/clerk` pointing to a
 * Homebrew Cellar or PM global dir is correctly attributed.
 */
export async function detectInstaller(): Promise<Installer> {
  // Stage 1: npm_config_user_agent
  const fromUA = detectFromUserAgent();
  if (fromUA) return fromUA;

  // Stage 2: process.execPath
  const execPath = process.execPath;

  // 2a: Homebrew — Cellar path is distinctive and unambiguous
  if (isHomebrewPath(execPath)) return "homebrew";

  // 2b: Match against PM global directories (parallel queries)
  try {
    const pm = await matchPmFromExecPath(execPath);
    if (pm) return pm;
  } catch (error) {
    log.debug(`PM prefix detection failed: ${error}`);
  }

  // Stage 3: Fallback
  return "npm";
}

// ── Strategy B: PATH-priority-aware update detection ────────────────────────
//
// The single-`detectInstaller()` call is not enough: on a machine with more
// than one global install (e.g. bun + asdf-managed npm), `npm install -g` can
// land in the wrong prefix while the shell still resolves `clerk` to the
// bun-installed binary. To fix this the update command needs to (1) discover
// every `clerk` on PATH in PATH order, (2) ask which installer owns the FIRST
// one, and (3) run that installer — not whatever `process.execPath` suggests.
//
// The helpers below implement steps (1) and (2a). Step (2b) — the actual
// path→installer decision — is intentionally left as a TODO for a contributor
// to fill in; see `ownerOfBinary` at the bottom.

/**
 * Walk the current process PATH and return symlink-resolved absolute paths to
 * every `clerk` binary found, in PATH order. Duplicates (same realpath reached
 * via two PATH entries) are collapsed; the first occurrence wins so PATH order
 * is preserved.
 *
 * Shell-agnostic by design — reads `process.env.PATH` directly rather than
 * shelling out to `which`/`where`, so it behaves identically under bash, zsh,
 * fish, Nushell, PowerShell, cmd, and any other shell that exports a standard
 * PATH to child processes. The sole shell-specific concern post-update is the
 * command hash table (bash/zsh `hash`, zsh/tcsh `rehash`, fish auto-rehashes)
 * — handled separately in the success message, not here.
 *
 * Platform handling:
 *  - POSIX: iterates PATH as-is, filters to regular files with the X bit set.
 *    Empty PATH entries (common via `::`) are ignored rather than being
 *    treated as CWD — safer default, matches most modern shells.
 *  - Windows: iterates PATHEXT extensions in declared order (first match per
 *    dir wins, matching Windows resolution), accepts any regular file (the
 *    X bit is meaningless on NTFS; PATHEXT is the gate).
 */
export async function findClerkOnPath(binaryName = UPDATE_PACKAGE_NAME): Promise<string[]> {
  const dirs = (process.env.PATH ?? "").split(delimiter).filter(Boolean);
  const exts =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(Boolean)
      : [""];

  const resolved: string[] = [];
  const seen = new Set<string>();
  for (const dir of dirs) {
    for (const ext of exts) {
      const candidate = join(dir, `${binaryName}${ext}`);
      if (!(await isExecutableFile(candidate))) continue;
      let real: string;
      try {
        real = await realpath(candidate);
      } catch {
        continue;
      }
      if (seen.has(real)) continue;
      seen.add(real);
      resolved.push(real);
      break; // first matching extension in this dir wins (Windows resolution order)
    }
  }
  return resolved;
}

/**
 * Is this path a regular file that the current process can actually execute?
 * On POSIX, "executable" means the X bit is set for the effective user.
 * On Windows, NTFS has no concept of executability — extension filtering in
 * findClerkOnPath() is what gates executability there, so we only confirm
 * the path is a regular file.
 */
async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const s = await stat(path);
    if (!s.isFile()) return false;
    if (process.platform === "win32") return true;
    await access(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Directories where each PM stores its globally-installed packages — i.e. the
 * parent of the `@clerk/cli-<arch>/` package folder, NOT where PMs put shim
 * symlinks. This is the bun-detection bug fix: `bun pm bin -g` returns the
 * symlink dir (~/.bun/bin), but the compiled platform binary actually lives
 * in ~/.bun/install/global/node_modules — so matching against the symlink dir
 * never succeeds. All four PMs are queried in parallel; a PM that isn't on
 * the system (nonzero exit, no output) is omitted from the result.
 */
export async function getInstallerPackageDirs(): Promise<Partial<Record<Installer, string>>> {
  const queries: Array<[Installer, Promise<string | null>]> = [
    ["npm", queryNpmPackageDir()],
    ["pnpm", queryPnpmPackageDir()],
    ["yarn", queryYarnPackageDir()],
    ["bun", queryBunPackageDir()],
  ];
  const out: Partial<Record<Installer, string>> = {};
  for (const [pm, p] of queries) {
    const dir = await p;
    if (dir) out[pm] = dir;
  }
  return out;
}

async function queryNpmPackageDir(): Promise<string | null> {
  const result = await Bun.$`npm prefix -g`.quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const prefix = result.stdout.toString().trim();
  return prefix ? await safeRealpath(join(prefix, "lib", "node_modules")) : null;
}

async function queryPnpmPackageDir(): Promise<string | null> {
  const result = await Bun.$`pnpm root -g`.quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const dir = result.stdout.toString().trim();
  return dir ? await safeRealpath(dir) : null;
}

async function queryYarnPackageDir(): Promise<string | null> {
  const result = await Bun.$`yarn global dir`.quiet().nothrow();
  if (result.exitCode !== 0) return null;
  const dir = result.stdout.toString().trim();
  return dir ? await safeRealpath(join(dir, "node_modules")) : null;
}

async function queryBunPackageDir(): Promise<string | null> {
  // $BUN_INSTALL defaults to ~/.bun; packages live at $BUN_INSTALL/install/global/node_modules.
  // Falling back to the conventional path is safe because `clerk update` only runs from an
  // installed clerk, which means Bun's layout (if used) is already in place.
  const root = process.env.BUN_INSTALL ?? join(homedir(), ".bun");
  return await safeRealpath(join(root, "install", "global", "node_modules"));
}

/**
 * Given the symlink-resolved absolute path to a clerk binary and the install
 * dirs returned by `getInstallerPackageDirs()`, return which installer owns
 * that specific binary — or `null` if no known installer does.
 *
 * Homebrew is matched first via its distinctive `/Cellar/clerk/` pattern.
 * Each PM dir is matched with a trailing path separator to avoid the
 * `/a/b` vs `/a/bother` false-positive. When multiple PMs match (possible
 * under unusual nested-prefix configurations), the longest match wins —
 * a more specific prefix is a better answer than a shorter one.
 *
 * Returns `null` (NOT `"npm"`) when nothing matches. Callers use `null` as
 * the signal to refuse-rather-than-guess.
 */
export function ownerOfBinary(
  binaryPath: string,
  installDirs: Partial<Record<Installer, string>>,
): Installer | null {
  if (isHomebrewPath(binaryPath)) return "homebrew";

  let best: { installer: Installer; len: number } | null = null;
  for (const [pm, dir] of Object.entries(installDirs) as Array<[Installer, string]>) {
    if (!dir || !binaryPath.startsWith(dir + sep)) continue;
    if (!best || dir.length > best.len) best = { installer: pm, len: dir.length };
  }
  return best?.installer ?? null;
}

/**
 * Returns a human-readable install/update command for the given installer.
 */
export function globalInstallCommand(installer: Installer, packageSpec: string): string {
  switch (installer) {
    case "bun":
      return `bun add -g ${packageSpec}`;
    case "pnpm":
      return `pnpm add -g ${packageSpec}`;
    case "yarn":
      return `yarn global add ${packageSpec}`;
    case "homebrew":
      return `brew upgrade ${UPDATE_PACKAGE_NAME}`;
    default:
      return `npm install -g ${packageSpec}`;
  }
}
