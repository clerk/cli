// packages/cli-core/src/lib/browser.test.ts
import { describe, test, expect } from "bun:test";
import { createBrowser } from "./browser.ts";
import { createFakeSystem } from "./system.fake.ts";

describe("createBrowser", () => {
  test("spawns the platform opener", async () => {
    const system = createFakeSystem();
    system.queueSpawn({ exitCode: 0 });
    const browser = createBrowser(system);
    const res = await browser.open("https://example.com");
    expect(res.ok).toBe(true);
    expect(system.calls.spawn[0]?.cmd.at(-1)).toBe("https://example.com");
  });

  test("returns { ok: false } on non-zero exit", async () => {
    const system = createFakeSystem();
    system.queueSpawn({ exitCode: 1 });
    const browser = createBrowser(system);
    const res = await browser.open("https://example.com");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("exit code 1");
  });

  test("returns { ok: false } when spawn throws", async () => {
    const system = createFakeSystem();
    system.queueSpawn({ throw: new Error("ENOENT") });
    const browser = createBrowser(system);
    const res = await browser.open("https://example.com");
    expect(res.ok).toBe(false);
    expect(res.reason).toContain("ENOENT");
  });
});
