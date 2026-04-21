import { join } from "node:path";

/**
 * Canonical list of package managers the CLI recognizes. Single source of
 * truth for both the `PackageManager` type and the Commander `--pm` choices.
 */
export const PACKAGE_MANAGERS = ["bun", "pnpm", "yarn", "npm"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

/** Detects the package manager in use by checking for lockfiles in `cwd`. */
export async function detectPackageManager(cwd: string): Promise<PackageManager> {
  const checks: Array<{ files: string[]; pm: PackageManager }> = [
    { files: ["bun.lockb", "bun.lock"], pm: "bun" },
    { files: ["yarn.lock"], pm: "yarn" },
    { files: ["pnpm-lock.yaml"], pm: "pnpm" },
  ];

  for (const { files, pm } of checks) {
    for (const file of files) {
      if (await Bun.file(join(cwd, file)).exists()) return pm;
    }
  }
  return "npm";
}
