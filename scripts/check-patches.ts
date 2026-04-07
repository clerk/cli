/**
 * Verify that every entry in the root package.json's `patchedDependencies`
 * is internally consistent: the patch file exists, the declared version
 * matches the version actually installed in node_modules, and the patch
 * hunks are currently applied byte-for-byte to the installed package.
 *
 * Also detects orphaned patch files (files under patches/ that no
 * patchedDependencies entry references).
 *
 * Run via: `bun run check:patches`
 *
 * Designed to run in CI on every PR (including Dependabot PRs, which skip
 * the E2E job and would otherwise let a silent patch regression through).
 */

import { resolve } from "node:path";

export interface CheckPatchesOptions {
  repoRoot: string;
}

export interface CheckPatchesResult {
  failures: string[];
  patchesChecked: number;
}

export async function checkPatches(opts: CheckPatchesOptions): Promise<CheckPatchesResult> {
  const failures: string[] = [];
  let patchesChecked = 0;
  // Implementation arrives in Tasks 2-4.
  return { failures, patchesChecked };
}

// CLI entrypoint
if (import.meta.main) {
  const repoRoot = resolve(import.meta.dir, "..");
  const result = await checkPatches({ repoRoot });
  if (result.failures.length > 0) {
    console.error("✗ patch check failed:");
    for (const failure of result.failures) {
      console.error(`  - ${failure}`);
    }
    process.exit(1);
  }
  const noun = result.patchesChecked === 1 ? "patch" : "patches";
  console.log(`✓ checked ${result.patchesChecked} ${noun}: all consistent and applied`);
}
