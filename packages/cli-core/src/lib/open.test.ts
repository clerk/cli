// packages/cli-core/src/lib/open.test.ts
import { describe, test, expect } from "bun:test";
import { createOpener } from "./open.ts";
import { createFakeSystem } from "./system.fake.ts";

const PLATFORM = process.platform;

/**
 * Candidate launcher the real `createOpener` will pick on the current platform.
 * Keep this aligned with the LAUNCHERS table in `./open.ts`.
 */
function expectedLauncher(): string {
  if (PLATFORM === "darwin") return "open";
  if (PLATFORM === "win32" || PLATFORM === "cygwin") return "start";
  return "xdg-open";
}

function primeWhich(system: ReturnType<typeof createFakeSystem>): string {
  const launcher = expectedLauncher();
  if (launcher !== "start") {
    // Make the first real candidate resolvable on PATH, and null out any
    // higher-priority ones (linux's "wslview" must be absent for xdg-open).
    system.setBinary("wslview", null);
    system.setBinary(launcher, `/usr/bin/${launcher}`);
  }
  return launcher;
}

describe("createOpener", () => {
  test("returns ok when launcher exits 0 within the grace window", async () => {
    const system = createFakeSystem();
    const launcher = primeWhich(system);
    system.queueSpawn({ exitCode: 0 });

    const opener = createOpener(system);
    const res = await opener.open("https://example.com");

    expect(res.ok).toBe(true);
    if (res.ok) expect(res.launcher).toBe(launcher);
    expect(system.calls.spawn[0]?.cmd.at(-1)).toBe("https://example.com");
  });

  test("returns spawn-failed on non-zero exit", async () => {
    const system = createFakeSystem();
    primeWhich(system);
    system.queueSpawn({ exitCode: 1 });

    const opener = createOpener(system);
    const res = await opener.open("https://example.com");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("spawn-failed");
  });

  test("returns spawn-failed when spawn throws", async () => {
    const system = createFakeSystem();
    primeWhich(system);
    system.queueSpawn({ throw: new Error("ENOENT") });

    const opener = createOpener(system);
    const res = await opener.open("https://example.com");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("spawn-failed");
  });

  test("returns no-launcher when nothing is on PATH", async () => {
    // Skip on Windows-like platforms where `start` is always-available and
    // can never produce a no-launcher outcome.
    if (PLATFORM === "win32" || PLATFORM === "cygwin") return;

    const system = createFakeSystem();
    // Explicitly make every candidate absent.
    for (const bin of [
      "wslview",
      "xdg-open",
      "gnome-open",
      "kde-open",
      "sensible-browser",
      "open",
    ]) {
      system.setBinary(bin, null);
    }

    const opener = createOpener(system);
    const res = await opener.open("https://example.com");

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.reason).toBe("no-launcher");
    // Never reached spawn.
    expect(system.calls.spawn.length).toBe(0);
  });

  test("filters candidates through system.which (never calls which for 'start')", async () => {
    if (PLATFORM !== "win32" && PLATFORM !== "cygwin") return;
    // On Windows, `start` should be picked without consulting which at all.
    const system = createFakeSystem();
    system.queueSpawn({ exitCode: 0 });

    const opener = createOpener(system);
    const res = await opener.open("https://example.com");

    expect(res.ok).toBe(true);
    expect(system.calls.which).not.toContain("start");
    // Command should be wrapped in cmd.exe /c start "" <url>.
    expect(system.calls.spawn[0]?.cmd).toEqual([
      "cmd.exe",
      "/c",
      "start",
      "",
      "https://example.com",
    ]);
  });
});
