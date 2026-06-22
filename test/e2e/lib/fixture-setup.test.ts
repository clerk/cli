import { test, expect, describe } from "bun:test";
import { tmpdir } from "node:os";
import { runStep } from "./fixture-setup.ts";

describe("runStep", () => {
  const base = { cwd: tmpdir(), env: process.env };

  test("resolves when the command exits 0", async () => {
    await expect(
      runStep("ok", ["bash", "-c", "exit 0"], { ...base, timeoutMs: 5_000 }),
    ).resolves.toBeUndefined();
  });

  test("rejects with a labeled error including stderr on non-zero exit", async () => {
    const err = await runStep("clerk link", ["bash", "-c", "echo boom >&2; exit 3"], {
      ...base,
      timeoutMs: 5_000,
    }).catch((e: unknown) => e);
    expect(String(err)).toMatch(/clerk link failed/);
    expect(String(err)).toMatch(/boom/);
  });

  test("kills the subprocess and rejects promptly when the step exceeds its timeout", async () => {
    const start = Date.now();
    const err = await runStep("slow", ["sleep", "10"], { ...base, timeoutMs: 150 }).catch(
      (e: unknown) => e,
    );
    expect(String(err)).toMatch(/slow timed out after 150ms/);
    // Proves the child was killed rather than awaited: sleep 10 would take ~10s.
    expect(Date.now() - start).toBeLessThan(2_000);
  });
});
