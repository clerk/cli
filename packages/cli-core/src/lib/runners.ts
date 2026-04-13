/**
 * Package runner detection.
 *
 * A "runner" is a way to invoke an npm package binary without installing it
 * globally: `bunx skills add ...`, `npx prettier ...`, `pnpm dlx skills ...`,
 * `yarn dlx skills ...`. Different runners are tied to different package
 * managers, so a project's preferred runner is usually the one matching the
 * package manager that produced its lockfile.
 *
 * This module exposes:
 *  - `Runner` — a tagged record describing one runner
 *  - `KNOWN_RUNNERS` — the four runners we know about, in preference order
 *  - `detectAvailableRunners()` — filters KNOWN_RUNNERS to those on the user's PATH
 *  - `preferredRunner()` — picks the best runner for a given package manager
 */

import type { ProjectContext } from "../commands/init/frameworks/types.js";

/**
 * One way to invoke an npm-published binary without installing it globally.
 *
 * `binary` is what we look up via `Bun.which()`. `prefixArgs` are the args
 * that come between the runner binary and the actual command — empty for
 * `bunx`/`npx`, `["dlx"]` for pnpm/yarn. `display` is the human-readable
 * label used in prompts and log lines.
 */
export type Runner = {
  readonly id: "bunx" | "npx" | "pnpm" | "yarn";
  readonly binary: string;
  readonly prefixArgs: readonly string[];
  readonly display: string;
};

/**
 * Known runners in preference order. When no project package manager is
 * provided, the first available runner from this list wins.
 */
export const KNOWN_RUNNERS: readonly Runner[] = [
  { id: "bunx", binary: "bunx", prefixArgs: [], display: "bunx" },
  { id: "npx", binary: "npx", prefixArgs: [], display: "npx" },
  { id: "pnpm", binary: "pnpm", prefixArgs: ["dlx"], display: "pnpm dlx" },
  { id: "yarn", binary: "yarn", prefixArgs: ["dlx"], display: "yarn dlx" },
];

/**
 * Maps a project's package manager (from `ctx.packageManager`, detected from
 * lockfiles in init/context.ts) to its preferred runner id.
 */
const PM_TO_RUNNER: Record<ProjectContext["packageManager"], Runner["id"]> = {
  bun: "bunx",
  npm: "npx",
  pnpm: "pnpm",
  yarn: "yarn",
};

/**
 * Probes the installed `yarn` binary for `dlx` support by running
 * `yarn dlx --help`. Yarn Berry (>=2) exits 0; Yarn Classic (v1) lacks the
 * subcommand and exits non-zero with `Command "dlx" not found.`. Returns
 * `false` on any spawn failure so a broken yarn never gets advertised.
 */
function yarnSupportsDlx(): boolean {
  try {
    const proc = Bun.spawnSync(["yarn", "dlx", "--help"], {
      stdout: "ignore",
      stderr: "ignore",
    });
    return proc.exitCode === 0;
  } catch {
    return false;
  }
}

/**
 * Returns the subset of {@link KNOWN_RUNNERS} that are actually installed on
 * the user's PATH. Uses `Bun.which()`, which returns the resolved binary path
 * or `null`. The `yarn` runner is additionally gated on a `yarn dlx --help`
 * probe so Yarn Classic (v1, no `dlx`) is not advertised.
 */
export function detectAvailableRunners(): Runner[] {
  return KNOWN_RUNNERS.filter((r) => {
    if (Bun.which(r.binary) === null) return false;
    if (r.id === "yarn") return yarnSupportsDlx();
    return true;
  });
}

/**
 * Returns the {@link Runner} spec matching a project's package manager,
 * regardless of whether it's installed on PATH. Useful for building
 * suggested-install messages when no runner is available locally yet.
 * Falls back to the first entry in {@link KNOWN_RUNNERS} when `packageManager`
 * is undefined.
 */
export function runnerForPackageManager(
  packageManager: ProjectContext["packageManager"] | undefined,
): Runner {
  if (!packageManager) return KNOWN_RUNNERS[0]!;
  const id = PM_TO_RUNNER[packageManager];
  return KNOWN_RUNNERS.find((r) => r.id === id) ?? KNOWN_RUNNERS[0]!;
}

/**
 * Pick the best runner from a set of available runners. Prefers the project's
 * own package-manager runner if it's installed (e.g. bun project + bunx →
 * bunx). Otherwise falls back to the first available runner in {@link KNOWN_RUNNERS}
 * order.
 *
 * Returns `undefined` only if `available` is empty.
 */
export function preferredRunner(
  packageManager: ProjectContext["packageManager"] | undefined,
  available: readonly Runner[],
): Runner | undefined {
  if (available.length === 0) return undefined;
  if (packageManager) {
    const preferredId = PM_TO_RUNNER[packageManager];
    const match = available.find((r) => r.id === preferredId);
    if (match) return match;
  }
  return available[0];
}

/**
 * Build the full spawn argv for invoking a command via a runner.
 *
 * @example
 * ```ts
 * runnerCommand(bunx, ["skills", "add", "clerk/skills"])
 * // => ["bunx", "skills", "add", "clerk/skills"]
 *
 * runnerCommand(pnpm, ["prettier", "--write", "file.ts"])
 * // => ["pnpm", "dlx", "prettier", "--write", "file.ts"]
 * ```
 */
export function runnerCommand(runner: Runner, args: readonly string[]): string[] {
  return [runner.binary, ...runner.prefixArgs, ...args];
}
