import { test, expect } from "bun:test";
import { join } from "node:path";

test("integration harness does not top-level await config imports", async () => {
  const source = await Bun.file(join(import.meta.dir, "harness.ts")).text();

  expect(source).not.toContain('await import("../../../lib/config.ts")');
});
