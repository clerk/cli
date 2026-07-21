import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stubFetch, useCaptureLog } from "../../test/lib/stubs.ts";
import { mcpRun, pipeEventStream, readTextCapped } from "./run.ts";

const URL = "https://mcp.clerk.com/mcp";

const INIT_RESULT = {
  jsonrpc: "2.0",
  id: 1,
  result: { protocolVersion: "2025-06-18", serverInfo: { name: "Clerk MCP Server" } },
};

interface Recorded {
  url: string;
  method: string;
  headers: Headers;
  body?: string;
}

let requests: Recorded[];

function stub(handler: (req: Recorded, postIndex: number) => Response): void {
  let posts = 0;
  stubFetch(async (input: unknown, init: RequestInit | undefined) => {
    const method = init?.method ?? "GET";
    const rec: Recorded = {
      url: String(input),
      method,
      headers: new Headers(init?.headers),
      body: init?.body ? String(init.body) : undefined,
    };
    requests.push(rec);
    return handler(rec, method === "POST" ? posts++ : -1);
  });
}

function json(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...headers },
  });
}

function sse(payload: unknown, headers: Record<string, string> = {}): Response {
  return new Response(`event: message\ndata: ${JSON.stringify(payload)}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream", ...headers },
  });
}

const noServerStream = (req: Recorded): Response | undefined =>
  req.method === "GET" ? new Response(null, { status: 405 }) : undefined;

async function* lines(...messages: unknown[]): AsyncGenerator<string> {
  for (const message of messages) yield JSON.stringify(message) + "\n";
}

function framesFrom(chunks: string[]): Array<Record<string, unknown>> {
  return chunks
    .join("")
    .trim()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

describe("mcp run (stdio bridge)", () => {
  useCaptureLog();
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    requests = [];
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("proxies the initialize handshake and threads the session id onward", async () => {
    stub((req) => noServerStream(req) ?? json(INIT_RESULT, { "mcp-session-id": "sess-1" }));
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ),
        write: (c) => out.push(c),
      },
    );

    expect(framesFrom(out)[0]).toEqual(INIT_RESULT);
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[0]!.headers.get("mcp-session-id")).toBeNull();
    expect(posts[1]!.headers.get("mcp-session-id")).toBe("sess-1");
    expect(posts[1]!.headers.get("mcp-protocol-version")).toBe("2025-06-18");
  });

  test("forwards an initialize answered over SSE", async () => {
    stub((req) => noServerStream(req) ?? sse(INIT_RESULT, { "mcp-session-id": "sess-1" }));
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: lines({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        write: (c) => out.push(c),
      },
    );

    expect(framesFrom(out)[0]).toEqual(INIT_RESULT);
  });

  test("proxies a tools/list request and reply", async () => {
    const toolsResult = { jsonrpc: "2.0", id: 2, result: { tools: [{ name: "create_user" }] } };
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      return postIndex === 0 ? json(INIT_RESULT, { "mcp-session-id": "s" }) : json(toolsResult);
    });
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ),
        write: (c) => out.push(c),
      },
    );

    expect(framesFrom(out)).toContainEqual(toolsResult);
  });

  test("forwards a server-initiated message from the GET event stream", async () => {
    const notification = {
      jsonrpc: "2.0",
      method: "notifications/message",
      params: { level: "info" },
    };
    stub((req) => {
      if (req.method === "GET") return sse(notification);
      return json(INIT_RESULT, { "mcp-session-id": "s" });
    });
    const out: string[] = [];
    // Keep stdin open until the server push lands, mirroring a real session
    // (the bridge cancels the GET stream on stdin EOF).
    let seen: () => void;
    const delivered = new Promise<void>((resolve) => (seen = resolve));
    const write = (c: string) => {
      out.push(c);
      if (c.includes("notifications/message")) seen();
    };
    async function* input(): AsyncGenerator<string> {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }) + "\n";
      await delivered;
    }

    await mcpRun({ url: URL }, { input: input(), write });

    expect(framesFrom(out)).toContainEqual(notification);
  });

  test("returns cleanly when stdin closes with no input", async () => {
    stub(() => new Response(null, { status: 405 }));
    const out: string[] = [];

    await mcpRun({ url: URL }, { input: lines(), write: (c) => out.push(c) });

    expect(out.join("")).toBe("");
  });

  test("surfaces a 401 from the upstream as a CliError", async () => {
    stub((req) => noServerStream(req) ?? new Response("unauthorized", { status: 401 }));

    await expect(
      mcpRun(
        { url: URL },
        {
          input: lines({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
          write: () => {},
        },
      ),
    ).rejects.toMatchObject({ code: "mcp_client_config_invalid" });
  });

  test("clears the session and replies with an error when it expires (404)", async () => {
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      return postIndex === 0
        ? json(INIT_RESULT, { "mcp-session-id": "s" })
        : new Response("gone", { status: 404 });
    });
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ),
        write: (c) => out.push(c),
      },
    );

    const expiry = framesFrom(out).find((f) => f.id === 2);
    const error = expiry?.error as { code?: number } | undefined;
    expect(error?.code).toBe(-32001);
  });

  test("drops the session header on the request after a 404 expiry", async () => {
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      if (postIndex === 0) return json(INIT_RESULT, { "mcp-session-id": "s" });
      if (postIndex === 1) return new Response("gone", { status: 404 });
      return json({ jsonrpc: "2.0", id: 3, result: {} });
    });

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
          { jsonrpc: "2.0", id: 3, method: "ping" },
        ),
        write: () => {},
      },
    );

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[1]!.headers.get("mcp-session-id")).toBe("s");
    expect(posts[2]!.headers.get("mcp-session-id")).toBeNull();
  });

  test("a 401 after the session is established replies per-request instead of crashing", async () => {
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      return postIndex === 0
        ? json(INIT_RESULT, { "mcp-session-id": "s" })
        : new Response("forbidden", { status: 401 });
    });
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/call" },
        ),
        write: (c) => out.push(c),
      },
    );

    const err = framesFrom(out).find((f) => f.id === 2);
    expect((err?.error as { code?: number } | undefined)?.code).toBe(-32001);
  });

  test("splits a JSON-RPC batch response into individual frames", async () => {
    const batch = [
      { jsonrpc: "2.0", id: 2, result: { a: 1 } },
      { jsonrpc: "2.0", id: 3, result: { b: 2 } },
    ];
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      return postIndex === 0 ? json(INIT_RESULT, { "mcp-session-id": "s" }) : json(batch);
    });
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          { jsonrpc: "2.0", id: 2, method: "tools/list" },
        ),
        write: (c) => out.push(c),
      },
    );

    const frames = framesFrom(out);
    expect(frames.find((f) => f.id === 2)).toEqual(batch[0]!);
    expect(frames.find((f) => f.id === 3)).toEqual(batch[1]!);
  });

  test("replies with an error instead of crashing on a non-JSON 200 body", async () => {
    stub(
      (req) =>
        noServerStream(req) ??
        new Response("upstream is on fire", {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
    );
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      { input: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (c) => out.push(c) },
    );

    expect((framesFrom(out)[0]?.error as { code?: number } | undefined)?.code).toBe(-32000);
  });

  test("drops a non-object JSON body rather than emitting it", async () => {
    stub(
      (req) =>
        noServerStream(req) ??
        new Response("[1,2,3]", { status: 200, headers: { "content-type": "application/json" } }),
    );
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      { input: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (c) => out.push(c) },
    );

    expect(out.join("")).toBe("");
  });

  test("replies with -32000 when an SSE response stream dies before the reply", async () => {
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: message\ndata: {"par'));
        controller.error(new Error("connection reset"));
      },
    });
    stub(
      (req) =>
        noServerStream(req) ??
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      { input: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (c) => out.push(c) },
    );

    const reply = framesFrom(out).find((f) => f.id === 1);
    expect((reply?.error as { code?: number } | undefined)?.code).toBe(-32000);
  });

  test("does not emit a duplicate error when the reply arrived before the stream died", async () => {
    const result = { jsonrpc: "2.0", id: 1, result: { tools: [] } };
    // Pull-based so the reply event is actually consumed before the error:
    // erroring inside start() would discard the queued chunk outright.
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(
            new TextEncoder().encode(`event: message\ndata: ${JSON.stringify(result)}\n\n`),
          );
          return;
        }
        controller.error(new Error("connection reset"));
      },
    });
    stub(
      (req) =>
        noServerStream(req) ??
        new Response(body, { status: 200, headers: { "content-type": "text/event-stream" } }),
    );
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      { input: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (c) => out.push(c) },
    );

    const replies = framesFrom(out).filter((f) => f.id === 1);
    expect(replies).toEqual([result]);
  });

  test("pipeEventStream discards an oversized buffer instead of growing unbounded", async () => {
    // The server->client SSE stream lives as long as the bridge process; a
    // stream that never emits a `\n\n` boundary must not accumulate forever.
    // Events that start after the discard still parse.
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode("x".repeat(100)));
        controller.enqueue(encoder.encode('data: {"ok":true}\n\n'));
        controller.close();
      },
    });
    const response = new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });
    const emitted: unknown[] = [];

    await pipeEventStream(response, async (p) => void emitted.push(p), { maxBufferBytes: 64 });

    expect(emitted).toEqual([{ ok: true }]);
  });

  test("ignores non-object JSON frames on stdin without dispatching them", async () => {
    // `5` and `[1,2]` are valid JSON but not JSON-RPC messages; forwarding
    // them upstream as no-op "notifications" would be silent garbage-in.
    stub((req) => noServerStream(req) ?? json(INIT_RESULT));
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: (async function* () {
          yield "5\n";
          yield "[1,2]\n";
        })(),
        write: (c) => out.push(c),
      },
    );

    expect(requests.filter((r) => r.method === "POST")).toHaveLength(0);
    expect(out).toEqual([]);
  });

  test("readTextCapped returns the body under the cap and undefined over it", async () => {
    expect(await readTextCapped(new Response("hello"), 64)).toBe("hello");
    expect(await readTextCapped(new Response("x".repeat(100)), 64)).toBeUndefined();
  });

  test("pipeEventStream removes its abort listener when the stream ends normally", async () => {
    const added: unknown[] = [];
    const removed: unknown[] = [];
    const signal = {
      aborted: false,
      addEventListener: (_type: string, fn: unknown) => void added.push(fn),
      removeEventListener: (_type: string, fn: unknown) => void removed.push(fn),
    } as unknown as AbortSignal;
    const response = new Response('event: message\ndata: {"jsonrpc":"2.0"}\n\n', {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    await pipeEventStream(response, async () => {}, { signal });

    expect(added).toHaveLength(1);
    expect(removed).toEqual(added);
  });

  test("targets the --url value", async () => {
    const custom = "http://localhost:9000/mcp";
    stub((req) => noServerStream(req) ?? json(INIT_RESULT));

    await mcpRun(
      { url: custom },
      {
        input: lines({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
        write: () => {},
      },
    );

    expect(requests.find((r) => r.method === "POST")?.url).toBe(custom);
  });
});
