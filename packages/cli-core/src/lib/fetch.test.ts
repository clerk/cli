import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetUserAgentCache, loggedFetch } from "./fetch.ts";
import { _setConfigDir, setTelemetryDisabled } from "./config.ts";

const originalFetch = globalThis.fetch;

describe("loggedFetch", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sets a Clerk-CLI User-Agent on outbound requests", async () => {
    globalThis.fetch = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await loggedFetch("https://example.test/x", { tag: "test" });
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    expect(init.headers.get("User-Agent")).toMatch(/^Clerk-CLI\//);
  });

  test("preserves a caller-provided User-Agent", async () => {
    globalThis.fetch = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await loggedFetch("https://example.test/x", {
      tag: "test",
      headers: { "User-Agent": "Custom/1.0" },
    });
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    expect(init.headers.get("User-Agent")).toBe("Custom/1.0");
  });

  test("preserves other caller-provided headers", async () => {
    globalThis.fetch = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await loggedFetch("https://example.test/x", {
      tag: "test",
      headers: { Authorization: "Bearer abc" },
    });
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    expect(init.headers.get("Authorization")).toBe("Bearer abc");
    expect(init.headers.get("User-Agent")).toMatch(/^Clerk-CLI\//);
  });
});

describe("AIAgent segment honors the telemetry opt-out", () => {
  let configDir: string;
  let originalClaudecode: string | undefined;

  async function sentUserAgent(): Promise<string> {
    globalThis.fetch = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await loggedFetch("https://example.test/x", { tag: "test" });
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    return init.headers.get("User-Agent")!;
  }

  beforeEach(async () => {
    configDir = await mkdtemp(join(tmpdir(), "clerk-fetch-test-"));
    _setConfigDir(configDir);
    _resetUserAgentCache();
    originalClaudecode = process.env.CLAUDECODE;
    process.env.CLAUDECODE = "1";
    delete process.env.CLERK_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    _setConfigDir(undefined);
    _resetUserAgentCache();
    if (originalClaudecode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = originalClaudecode;
    delete process.env.CLERK_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    await rm(configDir, { recursive: true, force: true });
  });

  test("segment present when telemetry is enabled", async () => {
    expect(await sentUserAgent()).toContain("AIAgent/claude_code");
  });

  test("segment omitted under an env opt-out", async () => {
    process.env.DO_NOT_TRACK = "yes";
    expect(await sentUserAgent()).not.toContain("AIAgent/");
  });

  test("segment omitted after clerk telemetry disable", async () => {
    await setTelemetryDisabled(true);
    expect(await sentUserAgent()).not.toContain("AIAgent/");
  });
});
