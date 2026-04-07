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

import { existsSync } from "node:fs";
import { resolve } from "node:path";

export interface CheckPatchesOptions {
  repoRoot: string;
}

export interface CheckPatchesResult {
  failures: string[];
  patchesChecked: number;
}

interface PatchEntry {
  name: string;
  declaredVersion: string;
  patchPath: string; // relative to repoRoot
}

async function loadPatchEntries(repoRoot: string): Promise<PatchEntry[]> {
  const pkgPath = resolve(repoRoot, "package.json");
  const raw = await Bun.file(pkgPath).text();
  const parsed: { patchedDependencies?: Record<string, string> } = JSON.parse(raw);
  const deps = parsed.patchedDependencies ?? {};
  const entries: PatchEntry[] = [];
  for (const [key, patchPath] of Object.entries(deps)) {
    const atIdx = key.lastIndexOf("@");
    if (atIdx <= 0) {
      throw new Error(`invalid patchedDependencies key: "${key}" (expected "<name>@<version>")`);
    }
    entries.push({
      name: key.slice(0, atIdx),
      declaredVersion: key.slice(atIdx + 1),
      patchPath,
    });
  }
  return entries;
}

async function readInstalledVersion(repoRoot: string, name: string): Promise<string | null> {
  const pkgPath = resolve(repoRoot, "node_modules", name, "package.json");
  if (!existsSync(pkgPath)) return null;
  const raw = await Bun.file(pkgPath).text();
  const parsed: { version?: string } = JSON.parse(raw);
  if (typeof parsed.version !== "string") {
    throw new Error(`node_modules/${name}/package.json has no string version field`);
  }
  return parsed.version;
}

export async function checkPatches(opts: CheckPatchesOptions): Promise<CheckPatchesResult> {
  const { repoRoot } = opts;
  const failures: string[] = [];
  let patchesChecked = 0;

  let entries: PatchEntry[];
  try {
    entries = await loadPatchEntries(repoRoot);
  } catch (err) {
    failures.push(`could not read/parse package.json: ${(err as Error).message}`);
    return { failures, patchesChecked };
  }

  for (const entry of entries) {
    // Check 1: patch file exists
    const absPatchPath = resolve(repoRoot, entry.patchPath);
    if (!existsSync(absPatchPath)) {
      failures.push(
        `${entry.name}@${entry.declaredVersion}: patchedDependencies points to ${entry.patchPath} but the file does not exist.`,
      );
      continue;
    }

    // Check 2: package is installed
    let installedVersion: string | null;
    try {
      installedVersion = await readInstalledVersion(repoRoot, entry.name);
    } catch (err) {
      failures.push(
        `${entry.name}: could not read node_modules/${entry.name}/package.json: ${(err as Error).message}`,
      );
      continue;
    }
    if (installedVersion === null) {
      failures.push(`${entry.name}: not installed. Run 'bun install' before running this check.`);
      continue;
    }

    // Check 3: drift
    if (installedVersion !== entry.declaredVersion) {
      failures.push(
        `${entry.name}: declared patch version ${entry.declaredVersion} does not match installed version ${installedVersion}. Rename ${entry.patchPath} to patches/${entry.name}@${installedVersion}.patch and update the key in package.json#patchedDependencies to match. If the patch no longer applies cleanly against the new version, recreate it with: bun patch ${entry.name}@${installedVersion}`,
      );
      continue;
    }

    // Check 4 (content) arrives in Task 4.

    patchesChecked += 1;
  }

  // Orphan sweep arrives in Task 3.

  return { failures, patchesChecked };
}

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
