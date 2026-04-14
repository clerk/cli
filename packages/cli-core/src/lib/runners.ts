/**
 * Package runner detection.
 *
 * Converts the legacy module-level helpers into a `createRunners(system)`
 * factory so the I/O (`Bun.which`, `Bun.spawnSync`) is routed through the
 * injected `System` collaborator. The pure helpers `runnerCommand` and
 * `runnerForPackageManager` remain standalone exports — no I/O, so no
 * reason to couple them to the factory.
 */

import type { System } from "./system.ts";
import type { ProjectContext } from "../commands/init/frameworks/types.js";

export type Runner = {
  readonly id: "bunx" | "npx" | "pnpm" | "yarn";
  readonly binary: string;
  readonly prefixArgs: readonly string[];
  readonly display: string;
};

export const KNOWN_RUNNERS: readonly Runner[] = [
  { id: "bunx", binary: "bunx", prefixArgs: [], display: "bunx" },
  { id: "npx", binary: "npx", prefixArgs: [], display: "npx" },
  { id: "pnpm", binary: "pnpm", prefixArgs: ["dlx"], display: "pnpm dlx" },
  { id: "yarn", binary: "yarn", prefixArgs: ["dlx"], display: "yarn dlx" },
];

const PM_TO_RUNNER: Record<ProjectContext["packageManager"], Runner["id"]> = {
  bun: "bunx",
  npm: "npx",
  pnpm: "pnpm",
  yarn: "yarn",
};

export interface Runners {
  detectAvailable(): Runner[];
  preferred(
    packageManager: ProjectContext["packageManager"] | undefined,
    available: readonly Runner[],
  ): Runner | undefined;
}

export function createRunners(system: System): Runners {
  function yarnSupportsDlx(): boolean {
    try {
      const proc = system.spawnSync(["yarn", "dlx", "--help"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      return proc.exitCode === 0;
    } catch {
      return false;
    }
  }

  return {
    detectAvailable() {
      return KNOWN_RUNNERS.filter((r) => {
        if (system.which(r.binary) === null) return false;
        if (r.id === "yarn") return yarnSupportsDlx();
        return true;
      });
    },
    preferred(packageManager, available) {
      if (available.length === 0) return undefined;
      if (packageManager) {
        const preferredId = PM_TO_RUNNER[packageManager];
        const match = available.find((r) => r.id === preferredId);
        if (match) return match;
      }
      return available[0];
    },
  };
}

/** Pure: map a project's package manager to its runner spec (no I/O). */
export function runnerForPackageManager(
  packageManager: ProjectContext["packageManager"] | undefined,
): Runner {
  if (!packageManager) return KNOWN_RUNNERS[0]!;
  const id = PM_TO_RUNNER[packageManager];
  return KNOWN_RUNNERS.find((r) => r.id === id) ?? KNOWN_RUNNERS[0]!;
}

/** Pure: build spawn argv for invoking `cmd` through `runner`. */
export function runnerCommand(runner: Runner, cmd: readonly string[]): string[] {
  return [runner.binary, ...runner.prefixArgs, ...cmd];
}
