import { afterEach, describe, expect, test } from "bun:test";
import { openBrowser } from "./open.ts";

const origWhich = Bun.which;
const origSpawn = Bun.spawn;
const origPlatform = process.platform;

const bunOverrides = Bun as unknown as {
  which: (bin: string) => string | null;
  spawn: (cmd: string[], opts?: unknown) => { exited: Promise<number> };
};

function stubPlatform(platform: NodeJS.Platform) {
  Object.defineProperty(process, "platform", { value: platform, writable: true });
}

/** Only the given binaries resolve on PATH. */
function stubWhich(available: Record<string, string>) {
  bunOverrides.which = (bin) => available[bin] ?? null;
}

function stubWsl() {
  stubPlatform("linux");
  process.env.WSL_DISTRO_NAME = "Ubuntu";
}

/** Record spawned commands; every spawn exits 0 immediately. */
function captureSpawn(): string[][] {
  const commands: string[][] = [];
  bunOverrides.spawn = (cmd) => {
    commands.push(cmd);
    return { exited: Promise.resolve(0) };
  };
  return commands;
}

afterEach(() => {
  bunOverrides.which = origWhich as typeof bunOverrides.which;
  bunOverrides.spawn = origSpawn as typeof bunOverrides.spawn;
  Object.defineProperty(process, "platform", { value: origPlatform, writable: true });
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;
});

const OAUTH_URL = "https://example.com/oauth?client_id=abc&response_type=code&state=xyz";

describe("openBrowser", () => {
  test("win32: quotes URL so ampersands are not treated as cmd.exe separators", async () => {
    stubPlatform("win32");
    const spawned = captureSpawn();

    const result = await openBrowser(OAUTH_URL);

    expect(result.ok).toBe(true);
    // cmd.exe /c 'start "" "<url>"' — passed as a single string so cmd.exe
    // parses it as a shell command line, preserving the quotes around the URL.
    expect(spawned).toEqual([["cmd.exe", "/c", `start "" "${OAUTH_URL}"`]]);
  });

  test("non-win32: passes URL without extra quoting", async () => {
    stubPlatform("linux");
    stubWhich({ "xdg-open": "/usr/bin/xdg-open" });
    const spawned = captureSpawn();

    const result = await openBrowser(OAUTH_URL);

    expect(result.ok).toBe(true);
    expect(spawned).toEqual([["xdg-open", OAUTH_URL]]);
  });

  test("WSL: prefers wslview when installed", async () => {
    stubWsl();
    stubWhich({ wslview: "/usr/bin/wslview", "powershell.exe": "/mnt/c/powershell.exe" });
    const spawned = captureSpawn();

    const result = await openBrowser(OAUTH_URL);

    expect(result.ok).toBe(true);
    expect(spawned).toEqual([["wslview", OAUTH_URL]]);
  });

  test("WSL: falls back to powershell.exe interop when wslview is missing", async () => {
    stubWsl();
    // Typical WSL without wslu: only Windows interop binaries resolve; xdg-open
    // is absent (no Linux desktop environment).
    stubWhich({
      "powershell.exe": "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe",
    });
    const spawned = captureSpawn();

    const result = await openBrowser(OAUTH_URL);

    expect(result.ok).toBe(true);
    // Single-quoted so `&` in the query string is not a PowerShell operator.
    expect(spawned).toEqual([
      [
        "powershell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Start-Process '${OAUTH_URL}'`,
      ],
    ]);
  });

  test("WSL: escapes single quotes in the URL for PowerShell", async () => {
    stubPlatform("linux");
    process.env.WSL_INTEROP = "/run/WSL/1_interop";
    stubWhich({ "powershell.exe": "/mnt/c/powershell.exe" });
    const spawned = captureSpawn();

    await openBrowser("https://example.com/path?q=it's");

    expect(spawned[0]?.[4]).toBe("Start-Process 'https://example.com/path?q=it''s'");
  });

  test("WSL: reports no-launcher when neither wslview nor interop binaries resolve", async () => {
    stubWsl();
    stubWhich({});

    const result = await openBrowser("https://example.com");

    expect(result).toEqual({ ok: false, reason: "no-launcher" });
  });
});
