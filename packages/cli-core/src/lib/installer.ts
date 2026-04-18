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
// is a common combo), runtime-based detection isn't enough: `npm install -g`
// can land in the wrong prefix while the shell still resolves `clerk` to a
// different binary. findClerkOnPath walks PATH so the caller can target the
// first-on-PATH install, i.e. what the user's shell will actually execute.

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

async function safeRealpath(p: string): Promise<string> {
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
  // realpath (e.g. `C:\…` vs `c:\…`). Normalize both sides before comparison.
  const normalize = (p: string): string =>
    process.platform === "win32" ? p.toLowerCase().replace(/\//g, sep) : p;
  const target = normalize(binaryPath);

  let best: { installer: Installer; len: number } | null = null;
  for (const [pm, dir] of Object.entries(installDirs) as Array<[Installer, string]>) {
    if (!dir) continue;
    const prefix = normalize(dir) + sep;
    if (!target.startsWith(prefix)) continue;
    if (!best || dir.length > best.len) best = { installer: pm, len: dir.length };
  }
  return best?.installer ?? null;
}

// ── Install command strings ─────────────────────────────────────────────────

/** Human-readable install/update command for the given installer. */
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
