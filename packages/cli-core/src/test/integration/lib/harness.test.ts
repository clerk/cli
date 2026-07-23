import { test, expect } from "bun:test";
import { join } from "node:path";

const AWAITED_CONFIG_IMPORT = /await\s+import\(\s*["']\.\.\/\.\.\/\.\.\/lib\/config\.ts["']\s*\)/;

test("integration harness does not top-level await config imports", async () => {
  const source = await Bun.file(join(import.meta.dir, "harness.ts")).text();
  expect(source).not.toMatch(AWAITED_CONFIG_IMPORT);
});
