// This file contains two categories of tests:
// 1. Real-repo test: runs checkPatches against the actual repo state.
// 2. Isolated fixture tests: spin up temp directories to exercise specific
//    failure modes without touching the real repo.

import { test, expect, describe, afterEach } from "bun:test";
import { resolve } from "node:path";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { checkPatches } from "./check-patches.ts";

const repoRoot = resolve(import.meta.dir, "..");

// Real-repo happy path: verifies the current repo state end-to-end.
test("checkPatches: real repo state has zero failures", async () => {
  const result = await checkPatches({ repoRoot });
  expect(result.failures).toEqual([]);
  expect(result.patchesChecked).toBeGreaterThan(0);
});

// Isolated fixture tests: construct a temp repoRoot with fake package.json,
// patches/, and node_modules/ trees, then assert specific failure modes.
describe("isolated fixture tests", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tempDirs.length = 0;
  });

  function makeTempRepo(): string {
    const dir = mkdtempSync(resolve(tmpdir(), "check-patches-"));
    tempDirs.push(dir);
    return dir;
  }

  test("reports drift when declared version mismatches installed version", async () => {
    const root = makeTempRepo();

    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({
        name: "fixture",
        patchedDependencies: {
          "fake-pkg@1.0.0": "patches/fake-pkg@1.0.0.patch",
        },
      }),
    );

    mkdirSync(resolve(root, "patches"));
    writeFileSync(resolve(root, "patches", "fake-pkg@1.0.0.patch"), "");

    mkdirSync(resolve(root, "node_modules", "fake-pkg"), { recursive: true });
    writeFileSync(
      resolve(root, "node_modules", "fake-pkg", "package.json"),
      JSON.stringify({ name: "fake-pkg", version: "1.0.1" }),
    );

    const result = await checkPatches({ repoRoot: root });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("fake-pkg");
    expect(result.failures[0]).toContain("1.0.0");
    expect(result.failures[0]).toContain("1.0.1");
    // A failed check does not count as a verified patch, so patchesChecked is 0.
    expect(result.patchesChecked).toBe(0);
  });

  test("reports orphan when patches/*.patch is not referenced", async () => {
    const root = makeTempRepo();

    // No patchedDependencies declared
    writeFileSync(
      resolve(root, "package.json"),
      JSON.stringify({ name: "fixture", patchedDependencies: {} }),
    );

    // Stale orphan patch file on disk
    mkdirSync(resolve(root, "patches"));
    writeFileSync(resolve(root, "patches", "stale.patch"), "");

    const result = await checkPatches({ repoRoot: root });
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]).toContain("stale.patch");
    expect(result.failures[0]).toContain("orphaned");
    expect(result.patchesChecked).toBe(0);
  });
});
