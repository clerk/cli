/**
 * Path-based installer detection for `clerk update`.
 *
 * Maps a resolved binary path to the package manager that owns it by comparing
 * against each PM's install directory. Handles asdf shims via `asdf which` and
 * exposes helpers for walking PATH and invoking per-installer global install
 * commands.
 */

import { constants as fsConstants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join, sep } from "node:path";
import { UPDATE_PACKAGE_NAME } from "./constants.ts";
import type { PackageManager } from "./package-manager.ts";

// ── Types ────────────────────────────────────────────────────────────────────

/** How the CLI was installed globally. */
export type Installer = "npm" | "bun" | "pnpm" | "yarn" | "homebrew";

// ── Homebrew path check ──────────────────────────────────────────────────────

export function isHomebrewPath(execPath: string): boolean {
  // Matches:
  //   /opt/homebrew/Cellar/clerk/...              (macOS Apple Silicon)
  //   /usr/local/Cellar/clerk/...                 (macOS Intel)
  //   /home/linuxbrew/.linuxbrew/Cellar/clerk/... (Linuxbrew)
  return /\/Cellar\/clerk\//.test(execPath);
}

// ── PATH discovery ───────────────────────────────────────────────────────────

// On a machine with more than one global install (bun + asdf-npm + Homebrew
// is a common combo), the caller needs to enumerate every install so it can
// report "other" installs and honor `--all`. Primary selection happens above
// this layer: the update command uses `findRunningInstallIndex` to pick the
// install that owns `process.execPath` rather than the first PATH hit.

/**
 * Returns symlink-resolved absolute paths to every `clerk` binary on PATH, in
 * PATH order. Duplicates (same realpath reached via two PATH entries) are
 * collapsed; first occurrence wins so PATH order is preserved.
 *
 * Shell-agnostic: reads `process.env.PATH` directly, no `which`/`where`
 * subshell. Post-update command-hash invalidation (`hash -r`, `rehash`) is
 * the caller's responsibility.
 *
 * Platform handling:
 *   POSIX: iterates PATH as-is; filters to regular files with the X bit set.
 *          Empty PATH entries (`::`) are ignored rather than treated as CWD.
 *   Windows: iterates PATHEXT in declared order; accepts any regular file
 *            since NTFS has no X bit.
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
 * Regular file that the current process can execute. On POSIX, checks the X
 * bit. On Windows, PATHEXT filtering at the caller is the executability gate,
 * so we only verify the path is a regular file.
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
 * `realpath` that returns the input path unchanged on any error (missing file,
 * permission denied, etc.) instead of throwing. Used wherever a best-effort
 * symlink resolution is good enough — matching against installer dirs still
 * works if both sides stay unresolved, and callers can't meaningfully recover
 * from a failed realpath on a path the user asked about.
 */
export async function safeRealpath(p: string): Promise<string> {
  try {
    return await realpath(p);
  } catch {
    return p;
  }
}

// ── Installer install dirs ──────────────────────────────────────────────────

/**
 * Packages directory for each PM present on the system: the parent of the
 * `@clerk/cli-<arch>/` package folder, NOT the shim or bin dir.
 *
 * Bun stores packages at `$BUN_INSTALL/install/global/node_modules` while
 * `bun pm bin -g` returns the shim dir (`~/.bun/bin`); matching against the
 * shim dir never succeeds against a resolved platform binary, which is why
 * this helper returns the install dir directly.
 *
 * PMs not present on the system (nonzero exit, no output) are omitted.
 */
export async function getInstallerPackageDirs(): Promise<Partial<Record<Installer, string>>> {
  const [npm, pnpm, yarn, bun] = await Promise.all([
    queryNpmPackageDir(),
    queryPnpmPackageDir(),
    queryYarnPackageDir(),
    queryBunPackageDir(),
  ]);
  const out: Partial<Record<Installer, string>> = {};
  if (npm) out.npm = npm;
  if (pnpm) out.pnpm = pnpm;
  if (yarn) out.yarn = yarn;
  if (bun) out.bun = bun;
  return out;
}

const PM_PROBE_TIMEOUT_MS = 1500;

/**
 * Run a package-manager probe with stdin detached and a hard timeout, capturing
 * trimmed stdout on success. Returns null on any failure (spawn error, nonzero
 * exit, timeout, empty output).
 *
 * Why stdin is detached: corepack-shimmed PMs (yarn/pnpm/npm under recent Node
 * releases) prompt on stdin to download the requested package on first use.
 * Inheriting the parent's TTY makes that prompt block forever waiting for a
 * Y/n. `stdin: "ignore"` plus `COREPACK_ENABLE_DOWNLOAD_PROMPT=0` ensures
 * corepack errors out instead of prompting.
 *
 * Why the timeout: defense in depth. Even with stdin handled, slow shims, alias
 * scripts, or network-bound startup paths can still hang. 1500ms matches the
 * registry timeout in `fetchLatestVersion`.
 */
async function probePmDir(args: string[]): Promise<string | null> {
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  try {
    proc = Bun.spawn(args, {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "ignore",
      env: { ...process.env, COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" },
    });
  } catch {
    return null;
  }
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc?.kill();
  }, PM_PROBE_TIMEOUT_MS);
  try {
    const exitCode = await proc.exited;
    if (timedOut || exitCode !== 0) return null;
    // `stdout: "pipe"` always yields a ReadableStream; the union in the type
    // covers other stdout modes we don't use here.
    const stdout = await new Response(proc.stdout as ReadableStream<Uint8Array>).text();
    return stdout.trim() || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function queryNpmPackageDir(): Promise<string | null> {
  // `npm root -g` reports the actual global node_modules dir on both platforms
  // (POSIX: `<prefix>/lib/node_modules`; Windows: `<prefix>\node_modules`, no
  // `lib` segment). Constructing the path manually breaks on Windows.
  const dir = await probePmDir(["npm", "root", "-g"]);
  return dir ? await safeRealpath(dir) : null;
}

async function queryPnpmPackageDir(): Promise<string | null> {
  const dir = await probePmDir(["pnpm", "root", "-g"]);
  return dir ? await safeRealpath(dir) : null;
}

async function queryYarnPackageDir(): Promise<string | null> {
  const dir = await probePmDir(["yarn", "global", "dir"]);
  return dir ? await safeRealpath(join(dir, "node_modules")) : null;
}

async function queryBunPackageDir(): Promise<string | null> {
  const root = process.env.BUN_INSTALL || join(homedir(), ".bun");
  const dir = join(root, "install", "global", "node_modules");
  try {
    const s = await stat(dir);
    if (!s.isDirectory()) return null;
  } catch {
    return null;
  }
  return await safeRealpath(dir);
}

// ── asdf shim handling ───────────────────────────────────────────────────────

// asdf shims are bash scripts, not symlinks. `realpath` returns the shim
// itself, so ownerOfBinary can't match it against an installer's package dir.
// `asdf which` is the only way to chase the shim to the real binary.

function asdfDataDir(): string {
  return process.env.ASDF_DATA_DIR || join(homedir(), ".asdf");
}

function asdfShimsDir(): string {
  return join(asdfDataDir(), "shims");
}

export function isAsdfShimPath(path: string): boolean {
  return path.startsWith(asdfShimsDir() + sep);
}

/** Returns `path` unchanged when not a shim, asdf is missing, or resolution fails. */
export async function resolveAsdfShim(path: string): Promise<string> {
  if (!isAsdfShimPath(path)) return path;
  const name = path.slice((asdfShimsDir() + sep).length).split(sep)[0];
  if (!name) return path;
  try {
    const result = await Bun.$`asdf which ${name}`.quiet().nothrow();
    if (result.exitCode !== 0) return path;
    const real = result.stdout.toString().trim();
    if (!real) return path;
    return await safeRealpath(real);
  } catch {
    return path;
  }
}

export function asdfPluginFromPath(path: string): string | null {
  const installsDir = join(asdfDataDir(), "installs");
  const prefix = installsDir + sep;
  if (!path.startsWith(prefix)) return null;
  const plugin = path.slice(prefix.length).split(sep)[0];
  return plugin || null;
}

/** Best-effort; swallows errors. */
export async function asdfReshim(plugin: string): Promise<void> {
  try {
    await Bun.$`asdf reshim ${plugin}`.quiet().nothrow();
  } catch {}
}

// ── Ownership decision ──────────────────────────────────────────────────────

/**
 * Maps a resolved binary path to its owning installer, or `null` if none
 * matches. Homebrew is checked first via its distinctive Cellar pattern. PM
 * dirs are matched with a trailing separator (so `/a/b` doesn't match
 * `/a/bother`); when multiple match due to nested prefixes, the longest match
 * wins.
 *
 * `null` is the refuse-rather-than-guess signal; callers must NOT default to
 * "npm" on no match.
 */
export function ownerOfBinary(
  binaryPath: string,
  installDirs: Partial<Record<Installer, string>>,
): Installer | null {
  if (isHomebrewPath(binaryPath)) return "homebrew";

  // Windows paths are case-insensitive and can mix forward/back slashes after
  // realpath (e.g. `C:\…` vs `c:\…`). They can also come back with the Win32
  // extended-length prefix `\\?\` (realpath returns this for deep trees), or
  // the UNC variant `\\?\UNC\server\share\…` which is the same as
  // `\\server\share\…`. Normalize all of these before comparison.
  const target = normalizeWindowsPath(binaryPath);

  let best: { installer: Installer; len: number } | null = null;
  for (const [pm, dir] of Object.entries(installDirs) as Array<[Installer, string]>) {
    if (!dir) continue;
    const normalizedDir = normalizeWindowsPath(dir);
    const prefix = normalizedDir + sep;
    if (!target.startsWith(prefix)) continue;
    if (!best || normalizedDir.length > best.len) {
      best = { installer: pm, len: normalizedDir.length };
    }
  }
  return best?.installer ?? null;
}

/**
 * Index of the candidate install that owns `execPath` (the currently-running
 * binary), or `-1` if none matches.
 *
 * Matching is by owning installer, not path equality: `PATH` exposes a
 * symlink/shim (e.g. `~/.bun/bin/clerk`) while `process.execPath` lands on the
 * platform binary beneath it (e.g.
 * `~/.bun/install/global/node_modules/@clerk/cli-<arch>/bin/clerk`). Both
 * resolve to the same owner under `installDirs`, which uniquely identifies
 * the install (each installer tracks one active dir).
 *
 * Callers use this to promote the running install to "primary" regardless of
 * `PATH` order — the binary the user just invoked is the authoritative
 * update target. Shell hash caches (zsh/bash) and asdf-vs-bun `PATH` ordering
 * can make a fresh `PATH` walk pick a different install than the one that
 * actually ran.
 *
 * Inactive asdf-nodejs versions: when the running binary sits under an asdf
 * nodejs install that is NOT the shell's currently-active one,
 * `installDirs.npm` (from `npm root -g`) points at a sibling version, so
 * `ownerOfBinary(execPath, installDirs)` returns `null` and this helper
 * returns `-1`. Callers fall back to PATH order rather than mismatching
 * against the active version.
 */
export function findRunningInstallIndex(
  candidates: ReadonlyArray<{ resolvedPath: string }>,
  execPath: string,
  installDirs: Partial<Record<Installer, string>>,
): number {
  const execOwner = ownerOfBinary(execPath, installDirs);
  if (execOwner === null) return -1;
  return candidates.findIndex((c) => ownerOfBinary(c.resolvedPath, installDirs) === execOwner);
}

/**
 * Strips Win32 namespace prefixes (`\\?\` and `\\?\UNC\`), unifies slashes to
 * the platform separator, and lowercases on Windows. No-op on POSIX.
 */
function normalizeWindowsPath(p: string): string {
  if (process.platform !== "win32") return p;
  let out = p;
  if (out.startsWith("\\\\?\\UNC\\")) out = "\\\\" + out.slice(8);
  else if (out.startsWith("\\\\?\\")) out = out.slice(4);
  return out.toLowerCase().replace(/\//g, sep);
}

// ── Install command strings ─────────────────────────────────────────────────

// Human-facing upgrade-Clerk commands. Intentionally NOT built from
// `pmInstallCommand`: that helper adds `--ignore-pnpmfile` / `--ignore-scripts`
// to defend `clerk init`'s spawn in attacker-controlled cwd. Those flags
// don't belong in an upgrade hint a user copy-pastes to install the trusted
// `clerk` package globally — postinstall scripts are how some PMs link the
// binary into PATH.
const GLOBAL_UPDATE_COMMANDS = {
  bun: "bun add -g",
  pnpm: "pnpm add -g",
  npm: "npm install -g",
} satisfies Record<Exclude<PackageManager, "yarn">, string>;

/** Human-readable install/update command for the given installer. */
export function globalInstallCommand(installer: Installer, packageSpec: string): string {
  if (installer === "homebrew") return `brew upgrade ${UPDATE_PACKAGE_NAME}`;
  if (installer === "yarn") return `yarn global add ${packageSpec}`;
  return `${GLOBAL_UPDATE_COMMANDS[installer]} ${packageSpec}`;
}
