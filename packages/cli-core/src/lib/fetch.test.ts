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

  // A server that accepts the connection but never responds. The mock rejects
  // only when the request's AbortSignal fires, so it exercises the real timeout
  // path: without a default timeout this hangs until bun's test timeout.
  const hangingFetch = () =>
    ((_url: unknown, init: { signal?: AbortSignal }) =>
      new Promise<Response>((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      })) as unknown as typeof fetch;

  test("aborts with a clear, tagged error after the default timeout when the server never responds", async () => {
    globalThis.fetch = hangingFetch();
    await expect(
      loggedFetch("https://example.test/hang", { tag: "plapi", timeoutMs: 30 }),
    ).rejects.toThrow(/plapi: request timed out after 30ms/);
  }, 2000);

  test("a shorter caller signal wins over the default timeout and is not masked by the timeout message", async () => {
    globalThis.fetch = hangingFetch();
    const caller = AbortSignal.timeout(20);
    // Must reject (the onFulfilled branch throws if it unexpectedly resolves)...
    const err = await loggedFetch("https://example.test/hang", {
      tag: "plapi",
      timeoutMs: 10_000,
      signal: caller,
    }).then(
      () => {
        throw new Error("expected loggedFetch to reject, but it resolved");
      },
      (e: unknown) => e,
    );
    // ...with the caller's 20ms abort, not relabeled as our 10s default timeout.
    expect(String(err)).not.toMatch(/timed out after 10000ms/);
  }, 2000);

  test("returns the response for a fast request without aborting", async () => {
    globalThis.fetch = mock(
      async () => new Response("ok", { status: 200 }),
    ) as unknown as typeof fetch;
    const res = await loggedFetch("https://example.test/ok", { tag: "plapi", timeoutMs: 5_000 });
    expect(res.status).toBe(200);
  });
});
