import { afterEach, describe, expect, test } from "bun:test";
import { stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";
import { probeMcp } from "./probe.ts";

const URL = "https://mcp.clerk.com/mcp";

const INITIALIZE_RESULT = {
  result: { serverInfo: { name: "Clerk MCP Server", version: "0.0.0" } },
  jsonrpc: "2.0",
  id: 1,
};

const DISCOVER_RESULT = {
  jsonrpc: "2.0",
  id: 1,
  result: {
    resultType: "complete",
    supportedVersions: ["2026-07-28"],
    capabilities: { tools: {} },
    _meta: {
      "io.modelcontextprotocol/serverInfo": { name: "Clerk MCP Server", version: "1.0.0" },
    },
  },
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

interface Recorded {
  body: Record<string, unknown>;
  headers: Headers;
}

/** Stub upstream with one handler per request body `method`. */
function stubByMethod(handlers: Record<string, (req: Recorded) => Response>): Recorded[] {
  const requests: Recorded[] = [];
  stubFetch(async (_input, init) => {
    const rec: Recorded = {
      body: JSON.parse(String(init?.body)) as Record<string, unknown>,
      headers: new Headers(init?.headers),
    };
    requests.push(rec);
    const handler = handlers[String(rec.body.method)];
    if (!handler) throw new Error(`unstubbed method ${String(rec.body.method)}`);
    return handler(rec);
  });
  return requests;
}

describe("probeMcp", () => {
  useCaptureLog();
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ── Modern era (2026-07-28-only and dual-era servers) ──────────────────────

  test("reports a modern server healthy from server/discover alone", async () => {
    const requests = stubByMethod({ "server/discover": () => jsonResponse(DISCOVER_RESULT) });

    expect(await probeMcp(URL)).toEqual({ ok: true, status: 200, serverName: "Clerk MCP Server" });
    expect(requests).toHaveLength(1);
  });

  test("sends modern per-request metadata and headers on server/discover", async () => {
    const requests = stubByMethod({ "server/discover": () => jsonResponse(DISCOVER_RESULT) });

    await probeMcp(URL);

    const [discover] = requests;
    expect(discover!.headers.get("mcp-protocol-version")).toBe("2026-07-28");
    expect(discover!.headers.get("mcp-method")).toBe("server/discover");
    const params = discover!.body.params as Record<string, Record<string, unknown>>;
    expect(params._meta!["io.modelcontextprotocol/protocolVersion"]).toBe("2026-07-28");
    expect(params._meta!["io.modelcontextprotocol/clientCapabilities"]).toEqual({});
  });

  test("parses a server/discover result delivered over SSE", async () => {
    stubByMethod({ "server/discover": () => sseResponse(DISCOVER_RESULT) });
    expect(await probeMcp(URL)).toMatchObject({ ok: true, serverName: "Clerk MCP Server" });
  });

  test("reports a modern server without serverInfo healthy with a placeholder name", async () => {
    // `io.modelcontextprotocol/serverInfo` is only SHOULD-required.
    const bare = { jsonrpc: "2.0", id: 1, result: { supportedVersions: ["2026-07-28"] } };
    stubByMethod({ "server/discover": () => jsonResponse(bare) });
    expect(await probeMcp(URL)).toMatchObject({ ok: true, serverName: "unnamed MCP server" });
  });

  test("retries with an advertised version on UnsupportedProtocolVersionError instead of falling back", async () => {
    const versions: (string | undefined)[] = [];
    const requests = stubByMethod({
      "server/discover": (req) => {
        const params = req.body.params as Record<string, Record<string, unknown>>;
        const version = params._meta?.["io.modelcontextprotocol/protocolVersion"];
        versions.push(typeof version === "string" ? version : undefined);
        if (version !== "2027-01-01") {
          return jsonResponse(
            {
              jsonrpc: "2.0",
              id: 1,
              error: {
                code: -32022,
                message: "Unsupported protocol version",
                data: { supported: ["2027-01-01"], requested: "2026-07-28" },
              },
            },
            400,
          );
        }
        return jsonResponse(DISCOVER_RESULT);
      },
    });

    expect(await probeMcp(URL)).toMatchObject({ ok: true, serverName: "Clerk MCP Server" });
    expect(versions).toEqual(["2026-07-28", "2027-01-01"]);
    // A recognized modern error must never trigger the legacy fallback.
    expect(requests.every((r) => r.body.method === "server/discover")).toBe(true);
  });

  test("reports a modern server rejecting for a missing client capability as reachable", async () => {
    // -32021 proves a live modern server; the probe can't know what capability
    // to declare, so like 401/403 this reads as "there, just gated" — healthy.
    const requests = stubByMethod({
      "server/discover": () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, error: { code: -32021, message: "capability required" } },
          400,
        ),
    });

    expect(await probeMcp(URL)).toMatchObject({ ok: true, serverName: "unnamed MCP server" });
    expect(requests).toHaveLength(1);
  });

  test("a modern-looking error on a non-400 status is not proof of a modern server", async () => {
    // A proxy 5xx page that happens to parse as JSON with a reserved MCP code
    // must not suppress the legacy fallback — the spec's body inspection is
    // defined for 400 Bad Request only.
    stubByMethod({
      "server/discover": () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, error: { code: -32020, message: "gateway broke" } },
          502,
        ),
      initialize: () => jsonResponse(INITIALIZE_RESULT),
    });

    expect(await probeMcp(URL)).toEqual({ ok: true, status: 200, serverName: "Clerk MCP Server" });
  });

  test("a recognized modern error with no usable retry fails without probing legacy", async () => {
    const requests = stubByMethod({
      "server/discover": () =>
        jsonResponse(
          { jsonrpc: "2.0", id: 1, error: { code: -32020, message: "Header mismatch" } },
          400,
        ),
    });

    expect(await probeMcp(URL)).toMatchObject({
      ok: false,
      status: 400,
      error: expect.stringContaining("Header mismatch"),
    });
    expect(requests).toHaveLength(1);
  });

  // ── Legacy fallback ─────────────────────────────────────────────────────────

  test("falls back to initialize when discover gets a 400 with no modern error body", async () => {
    stubByMethod({
      "server/discover": () => new Response("Bad Request", { status: 400 }),
      initialize: () => jsonResponse(INITIALIZE_RESULT),
    });
    expect(await probeMcp(URL)).toEqual({ ok: true, status: 200, serverName: "Clerk MCP Server" });
  });

  test("falls back when a legacy server answers discover 200 with a JSON-RPC method-not-found error", async () => {
    stubByMethod({
      "server/discover": () =>
        jsonResponse({ jsonrpc: "2.0", id: 1, error: { code: -32601, message: "not found" } }),
      initialize: () => sseResponse(INITIALIZE_RESULT),
    });
    expect(await probeMcp(URL)).toMatchObject({ ok: true, serverName: "Clerk MCP Server" });
  });

  test("the legacy fallback still sends the legacy initialize handshake", async () => {
    const requests = stubByMethod({
      "server/discover": () => new Response(null, { status: 405 }),
      initialize: () => jsonResponse(INITIALIZE_RESULT),
    });

    await probeMcp(URL);

    const init = requests.find((r) => r.body.method === "initialize");
    const params = init!.body.params as Record<string, unknown>;
    expect(params.protocolVersion).toBe("2024-11-05");
  });

  test("reports the legacy failure when both eras fail, carrying the status", async () => {
    stubByMethod({
      "server/discover": () => new Response("nope", { status: 404 }),
      initialize: () => new Response("nope", { status: 404 }),
    });
    expect(await probeMcp(URL)).toEqual({ ok: false, status: 404 });
  });

  // ── Auth gating (either era) ────────────────────────────────────────────────

  test.each([[401], [403]])(
    "marks a %i answer on discover as auth-required without falling back",
    async (status) => {
      const requests = stubByMethod({
        "server/discover": () => new Response("unauthorized", { status }),
      });
      expect(await probeMcp(URL)).toEqual({ ok: false, status, authRequired: true });
      expect(requests).toHaveLength(1);
    },
  );

  test("marks a 401 on the legacy fallback as auth-required", async () => {
    stubByMethod({
      "server/discover": () => new Response("Bad Request", { status: 400 }),
      initialize: () => new Response("unauthorized", { status: 401 }),
    });
    expect(await probeMcp(URL)).toEqual({ ok: false, status: 401, authRequired: true });
  });

  // ── Legacy parsing details (unchanged behavior) ─────────────────────────────

  const legacy = (initialize: () => Response): void => {
    stubByMethod({ "server/discover": () => new Response(null, { status: 405 }), initialize });
  };

  test("parses a legacy SSE frame with CRLF line endings", async () => {
    legacy(() => sse(`event: message\r\ndata: ${JSON.stringify(INITIALIZE_RESULT)}\r\n\r\n`));
    expect((await probeMcp(URL)).ok).toBe(true);
  });

  test("reassembles a legacy SSE payload split across multiple data lines", async () => {
    legacy(() =>
      sse(
        `event: message\n` +
          `data: {"result":{"serverInfo":{"name":"Clerk MCP Server"}},\n` +
          `data: "jsonrpc":"2.0","id":1}\n\n`,
      ),
    );
    expect(await probeMcp(URL)).toMatchObject({ ok: true, serverName: "Clerk MCP Server" });
  });

  test("fails when the legacy SSE frame has no data line", async () => {
    legacy(() => sse("event: message\n\n"));
    expect(await probeMcp(URL)).toMatchObject({ ok: false });
  });

  test("fails when the legacy SSE data line is malformed JSON", async () => {
    legacy(() => sse("event: message\ndata: {broken\n\n"));
    expect(await probeMcp(URL)).toMatchObject({ ok: false });
  });

  test("fails when the legacy answer is 200 but not an MCP initialize result", async () => {
    legacy(() => jsonResponse({ hello: "world" }));
    expect(await probeMcp(URL)).toMatchObject({ ok: false, status: 200 });
  });

  test("a discover 200 with a non-JSON-RPC body falls back and fails cleanly", async () => {
    stubByMethod({
      "server/discover": () => jsonResponse({ hello: "world" }),
      initialize: () => jsonResponse({ hello: "world" }),
    });
    expect(await probeMcp(URL)).toMatchObject({ ok: false, status: 200 });
  });

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
