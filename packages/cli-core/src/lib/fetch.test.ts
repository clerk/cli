import { test, expect, describe, afterEach, mock } from "bun:test";
import { loggedFetch } from "./fetch.ts";

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
