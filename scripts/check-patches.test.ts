import { test, expect } from "bun:test";
import { resolve } from "node:path";
import { checkPatches } from "./check-patches.ts";

const repoRoot = resolve(import.meta.dir, "..");

test("checkPatches: real repo state has zero failures", async () => {
  const result = await checkPatches({ repoRoot });
  expect(result.failures).toEqual([]);
  expect(result.patchesChecked).toBeGreaterThan(0);
});
