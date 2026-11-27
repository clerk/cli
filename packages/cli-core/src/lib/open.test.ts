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
  Object.defineProperty(process, "platform", {
    value: platform,
    writable: true,
  });
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
  Object.defineProperty(process, "platform", {
    value: origPlatform,
    writable: true,
  });
  delete process.env.WSL_DISTRO_NAME;
  delete process.env.WSL_INTEROP;
});

const OAUTH_URL = "https://example.com/oauth?client_id=abc&response_type=code&state=xyz";

describe("openBrowser", () => {
  test("win32: opens the URL with rundll32, not through cmd.exe", async () => {
    stubPlatform("win32");
    stubWhich({ rundll32: "C:\\Windows\\System32\\rundll32.exe" });
    const spawned = captureSpawn();

    const result = await openBrowser(OAUTH_URL);

    expect(result).toEqual({ ok: true, launcher: "rundll32" });
    expect(spawned).toEqual([["rundll32", "url.dll,FileProtocolHandler", OAUTH_URL]]);
  });

  // No shell parses the argv, so cmd.exe metacharacters reach the handler as
  // written; space and `"` are percent-encoded so Bun's Windows argument
  // quoting has nothing to wrap or escape.
  test.each([
    [
      "%PATH% stays literal",
      "https://example.com/claim?t=%PATH%",
      "https://example.com/claim?t=%PATH%",
    ],
    ["& is not a separator", "https://example.com/?a=1&b=2", "https://example.com/?a=1&b=2"],
    ["^ is not an escape", "https://example.com/?q=a^b", "https://example.com/?q=a^b"],
    ['" is percent-encoded', 'https://example.com/?q="x"', "https://example.com/?q=%22x%22"],
    [
      "all of them together",
      'https://example.com/claim?t=%PATH%&x=a^b&q="hi" there',
      "https://example.com/claim?t=%PATH%&x=a^b&q=%22hi%22%20there",
    ],
  ])("win32: %s", async (_name, url, expected) => {
    stubPlatform("win32");
    stubWhich({ rundll32: "C:\\Windows\\System32\\rundll32.exe" });
    const spawned = captureSpawn();

    await openBrowser(url);

    expect(spawned).toEqual([["rundll32", "url.dll,FileProtocolHandler", expected]]);
  });

  test("win32: passes a URL that doesn't parse through unchanged", async () => {
    stubPlatform("win32");
    stubWhich({ rundll32: "C:\\Windows\\System32\\rundll32.exe" });
    const spawned = captureSpawn();

    await openBrowser("not a url %PATH%");

    expect(spawned).toEqual([["rundll32", "url.dll,FileProtocolHandler", "not a url %PATH%"]]);
  });

  test("win32: reports no-launcher when rundll32 is not on PATH", async () => {
    stubPlatform("win32");
    stubWhich({});
    const spawned = captureSpawn();

    const result = await openBrowser(OAUTH_URL);

    expect(result).toEqual({ ok: false, reason: "no-launcher" });
    expect(spawned).toEqual([]);
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
    stubWhich({
      wslview: "/usr/bin/wslview",
      "powershell.exe": "/mnt/c/powershell.exe",
    });
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
