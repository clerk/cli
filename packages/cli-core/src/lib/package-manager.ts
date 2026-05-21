import { join } from "node:path";

/**
 * Canonical list of package managers the CLI recognizes. Single source of
 * truth for both the `PackageManager` type and the Commander `--pm` choices.
 */
export const PACKAGE_MANAGERS = ["bun", "pnpm", "yarn", "npm"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

// Security: `clerk init` runs the user's package manager in attacker-controlled
// cwd to install the framework SDK. Two cwd-reachable code-exec primitives
// exist on a vanilla `<pm> add`/`<pm> install`:
//   1. pnpm autoloads `.pnpmfile.cjs` at install startup (top-level code runs
//      via `require()` before any package resolves). `--ignore-pnpmfile`
//      disables that loader.
//   2. Every PM runs lifecycle scripts (preinstall/install/postinstall) from
//      the project's package.json on every install. `--ignore-scripts` skips
//      them; the legitimate user re-runs install later for native modules.
//
// Single source of truth — `PM_INSTALL_COMMANDS` below and the `--starter`
// bootstrap install in `commands/init/bootstrap-registry.ts` both consume it.
export const PM_INSTALL_HARDENING_FLAGS = {
  bun: ["--ignore-scripts"],
  yarn: ["--ignore-scripts"],
  pnpm: ["--ignore-pnpmfile", "--ignore-scripts"],
  npm: ["--ignore-scripts"],
} as const satisfies Record<PackageManager, readonly string[]>;

const PM_INSTALL_COMMANDS = {
  bun: ["bun", "add", ...PM_INSTALL_HARDENING_FLAGS.bun].join(" "),
  yarn: ["yarn", "add", ...PM_INSTALL_HARDENING_FLAGS.yarn].join(" "),
  pnpm: ["pnpm", "add", ...PM_INSTALL_HARDENING_FLAGS.pnpm].join(" "),
  npm: ["npm", "install", ...PM_INSTALL_HARDENING_FLAGS.npm].join(" "),
} satisfies Record<PackageManager, string>;

/** Returns the `<pm> add`-style command for installing dependencies. */
export function pmInstallCommand(pm: PackageManager): string {
  return PM_INSTALL_COMMANDS[pm];
}

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
