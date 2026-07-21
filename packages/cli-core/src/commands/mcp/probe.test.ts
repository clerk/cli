import { afterEach, describe, expect, test } from "bun:test";
import { stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";
import { probeMcp } from "./probe.ts";

const URL = "https://mcp.clerk.com/mcp";

const INITIALIZE_RESULT = {
  result: { serverInfo: { name: "Clerk MCP Server", version: "0.0.0" } },
  jsonrpc: "2.0",
  id: 1,
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function sseResponse(payload: unknown): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  });
}

function sse(body: string): Response {
  return new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } });
}

describe("probeMcp", () => {
  useCaptureLog();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test.each([
    ["text/event-stream", sseResponse(INITIALIZE_RESULT)],
    ["application/json", jsonResponse(INITIALIZE_RESULT)],
  ])("returns ok with the server name via %s", async (_label, response) => {
    stubFetch(async () => response);
    expect(await probeMcp(URL)).toEqual({ ok: true, status: 200, serverName: "Clerk MCP Server" });
  });

  test("POSTs an initialize handshake", async () => {
    let method = "";
    let body = "";
    stubFetch(async (_input, init) => {
      method = init?.method ?? "";
      body = typeof init?.body === "string" ? init.body : "";
      return sseResponse(INITIALIZE_RESULT);
    });
    await probeMcp(URL);
    expect(method).toBe("POST");
    expect(body).toContain('"method":"initialize"');
  });

  test("parses an SSE frame with CRLF line endings", async () => {
    stubFetch(async () =>
      sse(`event: message\r\ndata: ${JSON.stringify(INITIALIZE_RESULT)}\r\n\r\n`),
    );
    expect((await probeMcp(URL)).ok).toBe(true);
  });

  test("reassembles an SSE payload split across multiple data lines", async () => {
    stubFetch(async () =>
      sse(
        `event: message\n` +
          `data: {"result":{"serverInfo":{"name":"Clerk MCP Server"}},\n` +
          `data: "jsonrpc":"2.0","id":1}\n\n`,
      ),
    );
    expect(await probeMcp(URL)).toMatchObject({ ok: true, serverName: "Clerk MCP Server" });
  });

  test("fails when the SSE frame has no data line", async () => {
    stubFetch(async () => sse("event: message\n\n"));
    expect(await probeMcp(URL)).toMatchObject({ ok: false });
  });

  test("fails when the SSE data line is malformed JSON", async () => {
    stubFetch(async () => sse("event: message\ndata: {broken\n\n"));
    expect(await probeMcp(URL)).toMatchObject({ ok: false });
  });

  test("fails when 200 but not an MCP initialize result", async () => {
    stubFetch(async () => jsonResponse({ hello: "world" }));
    expect(await probeMcp(URL)).toMatchObject({ ok: false, status: 200 });
  });

  test("fails on non-2xx, carrying the status", async () => {
    stubFetch(async () => new Response("nope", { status: 404 }));
    expect(await probeMcp(URL)).toEqual({ ok: false, status: 404 });
  });

  test.each([[401], [403]])(
    "marks a %i answer as auth-required, not unreachable",
    async (status) => {
      // An auth-gated server answered — it's demonstrably there. The editor runs
      // its own OAuth flow, so doctor must not flag the entry as unreachable.
      stubFetch(async () => new Response("unauthorized", { status }));
      expect(await probeMcp(URL)).toEqual({ ok: false, status, authRequired: true });
    },
  );

  test("fails on a network error, carrying the message", async () => {
    stubFetch(async () => {
      throw new Error("ECONNREFUSED");
    });
    expect(await probeMcp(URL)).toMatchObject({
      ok: false,
      error: expect.stringContaining("ECONNREFUSED"),
    });
  });
});
