import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { _resetUserAgentCache, loggedFetch } from "./fetch.ts";
import { _setConfigDir, markTelemetryNoticeShown, setTelemetryDisabled } from "./config.ts";

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
  let originalCi: string | undefined;

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
    originalCi = process.env.CI;
    process.env.CLAUDECODE = "1";
    delete process.env.CI;
    delete process.env.CLERK_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    _setConfigDir(undefined);
    _resetUserAgentCache();
    if (originalClaudecode === undefined) delete process.env.CLAUDECODE;
    else process.env.CLAUDECODE = originalClaudecode;
    if (originalCi === undefined) delete process.env.CI;
    else process.env.CI = originalCi;
    delete process.env.CLERK_TELEMETRY_DISABLED;
    delete process.env.DO_NOT_TRACK;
    await rm(configDir, { recursive: true, force: true });
  });

  test("segment present once the disclosure notice has been shown", async () => {
    await markTelemetryNoticeShown();
    expect(await sentUserAgent()).toContain("AIAgent/claude_code");
  });

  test("segment omitted before the disclosure notice has been shown", async () => {
    expect(await sentUserAgent()).not.toContain("AIAgent/");
  });

  test("segment present in CI even before the notice (CI is exempt from the grace)", async () => {
    process.env.CI = "1";
    expect(await sentUserAgent()).toContain("AIAgent/claude_code");
  });

  test("segment omitted under an env opt-out", async () => {
    await markTelemetryNoticeShown();
    process.env.DO_NOT_TRACK = "yes";
    expect(await sentUserAgent()).not.toContain("AIAgent/");
  });

  test("segment omitted after clerk telemetry disable", async () => {
    await markTelemetryNoticeShown();
    await setTelemetryDisabled(true);
    expect(await sentUserAgent()).not.toContain("AIAgent/");
  });
});

describe("loggedFetch interrupt signal", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  /** The signal `loggedFetch` actually handed to fetch. */
  async function signalPassedTo(options: Parameters<typeof loggedFetch>[1]): Promise<AbortSignal> {
    globalThis.fetch = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    await loggedFetch("https://example.test/x", options);
    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    return init.signal as AbortSignal;
  }

  test("requests are abortable by Ctrl-C", async () => {
    const signal = await signalPassedTo({ tag: "test" });
    expect(signal).toBeInstanceOf(AbortSignal);
    expect(signal.aborted).toBe(false);
  });

  test("a caller's own signal still aborts the request", async () => {
    const own = new AbortController();
    const signal = await signalPassedTo({ tag: "test", signal: own.signal });
    own.abort();
    // Composed with the interrupt signal rather than replaced by it, so a
    // caller's timeout keeps working.
    expect(signal.aborted).toBe(true);
  });

  test("ignoreInterrupt keeps the caller's signal untouched", async () => {
    const own = new AbortController();
    const signal = await signalPassedTo({
      tag: "test",
      signal: own.signal,
      ignoreInterrupt: true,
    });
    expect(signal).toBe(own.signal);
  });

  test("ignoreInterrupt with no caller signal sends none at all", async () => {
    // This is the shutdown telemetry flush: it runs after Ctrl-C has aborted
    // everything and must still be able to report that interrupt.
    const signal = await signalPassedTo({ tag: "test", ignoreInterrupt: true });
    expect(signal).toBeUndefined();
  });
});
