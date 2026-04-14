/**
 * Canonical list of package managers the CLI recognizes. Single source of
 * truth for both the `PackageManager` type and the Commander `--pm` choices.
 */
export const PACKAGE_MANAGERS = ["bun", "pnpm", "yarn", "npm"] as const;

export type PackageManager = (typeof PACKAGE_MANAGERS)[number];
