import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { JSONRPCMessageSchema, type JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
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

/**
 * Input/write pair where each message is yielded only after the reply to the
 * previous one has been written back — how a real MCP client sequences
 * dependent requests (e.g. tools/list before tools/call).
 */
function replyGated(...messages: Array<Record<string, unknown>>): {
  input: AsyncGenerator<string>;
  write: (chunk: string) => void;
} {
  const waiters = new Map<unknown, () => void>();
  const arrived = new Set<unknown>();
  const write = (chunk: string): void => {
    for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
      const frame = JSON.parse(line) as { id?: unknown };
      if (frame.id === undefined) continue;
      arrived.add(frame.id);
      waiters.get(frame.id)?.();
    }
  };
  async function* input(): AsyncGenerator<string> {
    for (const [i, message] of messages.entries()) {
      const prevId = i > 0 ? (messages[i - 1] as { id?: unknown }).id : undefined;
      if (prevId !== undefined && !arrived.has(prevId)) {
        await new Promise<void>((resolve) => waiters.set(prevId, resolve));
      }
      yield JSON.stringify(message) + "\n";
    }
  }
  return { input: input(), write };
}

function framesFrom(chunks: string[]): Array<Record<string, unknown>> {
  return (
    chunks
      .join("")
      .trim()
      .split("\n")
      .filter((line) => line.length > 0)
      // `.parse` throws if the bridge wrote anything that isn't a spec-valid
      // JSON-RPC frame, so every assertion below doubles as a conformance check —
      // a frame missing `jsonrpc: "2.0"` fails here, not just in a real client.
      .map((line) => JSONRPCMessageSchema.parse(JSON.parse(line)) as Record<string, unknown>)
  );
}

/**
 * Binds a real MCP SDK `Client` to the real bridge in-process: the client's
 * sends feed `mcpRun`'s injected `input` stream, and the bridge's stdout
 * writes come back through `onmessage` — no child process, upstream stubbed.
 */
class BridgeTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** The bridge's run promise, so tests can assert a clean shutdown. */
  done: Promise<void> = Promise.resolve();

  private queue: string[] = [];
  private wake: (() => void) | undefined;
  private closed = false;

  private async *input(): AsyncGenerator<string> {
    while (!this.closed || this.queue.length > 0) {
      const next = this.queue.shift();
      if (next !== undefined) {
        yield next;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((resolve) => (this.wake = resolve));
    }
  }

  async start(): Promise<void> {
    this.done = mcpRun(
      { url: URL },
      {
        input: this.input(),
        write: (chunk) => {
          for (const line of chunk.split("\n").filter((l) => l.length > 0)) {
            this.onmessage?.(JSONRPCMessageSchema.parse(JSON.parse(line)));
          }
        },
      },
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    this.queue.push(JSON.stringify(message) + "\n");
    this.wake?.();
    this.wake = undefined;
  }

  async close(): Promise<void> {
    this.closed = true;
    this.wake?.();
    this.wake = undefined;
    await this.done;
    this.onclose?.();
  }
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

  test("a real MCP SDK client completes initialize and tools/list through the bridge", async () => {
    // Conformance: if a genuine `Client` gets through `initialize` (with the
    // SDK validating the result shape) and `tools/list`, then session-id
    // threading and protocol-version echo work end to end — stronger than
    // asserting on hand-rolled frames.
    stub((req) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      const msg = JSON.parse(req.body!) as { id?: number; method?: string };
      if (msg.method === "initialize") {
        return json(
          {
            jsonrpc: "2.0",
            id: msg.id,
            result: {
              protocolVersion: "2025-06-18",
              capabilities: { tools: {} },
              serverInfo: { name: "Clerk MCP Server", version: "0.0.0" },
            },
          },
          { "mcp-session-id": "sess-1" },
        );
      }
      if (msg.method === "tools/list") {
        return json({
          jsonrpc: "2.0",
          id: msg.id,
          result: { tools: [{ name: "create_user", inputSchema: { type: "object" } }] },
        });
      }
      // Notifications (e.g. notifications/initialized) are accepted bodyless.
      return new Response(null, { status: 202 });
    });

    const transport = new BridgeTransport();
    const client = new Client({ name: "conformance-test", version: "0.0.0" });
    await client.connect(transport);
    const tools = await client.listTools();
    await client.close();
    await transport.done;

    expect(tools.tools.map((t) => t.name)).toEqual(["create_user"]);
    const posts = requests.filter((r) => r.method === "POST");
    expect(posts.at(-1)?.headers.get("mcp-session-id")).toBe("sess-1");
  });

  test("mirrors the body method into Mcp-Method on every relayed request", async () => {
    stub((req) => noServerStream(req) ?? json({ jsonrpc: "2.0", id: 1, result: {} }));

    await mcpRun(
      { url: URL },
      {
        input: lines({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        write: () => {},
      },
    );

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[0]!.headers.get("mcp-method")).toBe("tools/list");
  });

  test.each([
    ["tools/call", { name: "get_weather" }, "get_weather"],
    ["resources/read", { uri: "file:///a/b.json" }, "file:///a/b.json"],
    ["prompts/get", { name: "greet" }, "greet"],
  ])("mirrors the %s name into Mcp-Name", async (method, params, expected) => {
    stub((req) => noServerStream(req) ?? json({ jsonrpc: "2.0", id: 1, result: {} }));

    await mcpRun(
      { url: URL },
      { input: lines({ jsonrpc: "2.0", id: 1, method, params }), write: () => {} },
    );

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[0]!.headers.get("mcp-name")).toBe(expected);
  });

  test("Base64-sentinel-encodes a non-ASCII tool name in Mcp-Name", async () => {
    stub((req) => noServerStream(req) ?? json({ jsonrpc: "2.0", id: 1, result: {} }));

    await mcpRun(
      { url: URL },
      {
        input: lines({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "天気" } }),
        write: () => {},
      },
    );

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[0]!.headers.get("mcp-name")).toBe(
      `=?base64?${Buffer.from("天気", "utf8").toString("base64")}?=`,
    );
  });

  test("omits Mcp-Name on methods that don't define it", async () => {
    stub((req) => noServerStream(req) ?? json({ jsonrpc: "2.0", id: 1, result: {} }));

    await mcpRun(
      { url: URL },
      {
        input: lines({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
        write: () => {},
      },
    );

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[0]!.headers.get("mcp-name")).toBeNull();
  });

  test("derives MCP-Protocol-Version from the body _meta of a modern request", async () => {
    // A modern stdio client never sends initialize; the header must match the
    // per-request metadata or a strict server rejects with HeaderMismatch.
    stub((req) => noServerStream(req) ?? json({ jsonrpc: "2.0", id: 1, result: {} }));

    await mcpRun(
      { url: URL },
      {
        input: lines({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/list",
          params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
        }),
        write: () => {},
      },
    );

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[0]!.headers.get("mcp-protocol-version")).toBe("2026-07-28");
  });

  test("body _meta wins over the legacy-negotiated protocol version", async () => {
    stub((req) => noServerStream(req) ?? json(INIT_RESULT));

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
          {
            jsonrpc: "2.0",
            id: 2,
            method: "tools/list",
            params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } },
          },
        ),
        write: () => {},
      },
    );

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[1]!.headers.get("mcp-protocol-version")).toBe("2026-07-28");
  });

  test("mirrors x-mcp-header tool parameters into Mcp-Param headers on tools/call", async () => {
    const tools = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "execute_sql",
            inputSchema: {
              type: "object",
              properties: {
                region: { type: "string", "x-mcp-header": "Region" },
                query: { type: "string" },
              },
            },
          },
        ],
      },
    };
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      return postIndex === 0 ? json(tools) : json({ jsonrpc: "2.0", id: 2, result: {} });
    });

    // Like a real MCP client, wait for the tools/list reply (which carries
    // the schema annotations) before issuing the tools/call.
    const gate = replyGated(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: { name: "execute_sql", arguments: { region: "us-west1", query: "SELECT 1" } },
      },
    );
    await mcpRun({ url: URL }, gate);

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[1]!.headers.get("mcp-param-region")).toBe("us-west1");
    expect(posts[1]!.headers.get("mcp-param-query")).toBeNull();
  });

  test("omits the Mcp-Param header when the annotated argument is absent", async () => {
    const tools = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          {
            name: "t",
            inputSchema: {
              type: "object",
              properties: { region: { type: "string", "x-mcp-header": "Region" } },
            },
          },
        ],
      },
    };
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      return postIndex === 0 ? json(tools) : json({ jsonrpc: "2.0", id: 2, result: {} });
    });

    const gate = replyGated(
      { jsonrpc: "2.0", id: 1, method: "tools/list" },
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "t", arguments: {} } },
    );
    await mcpRun({ url: URL }, gate);

    const posts = requests.filter((r) => r.method === "POST");
    expect(posts[1]!.headers.get("mcp-param-region")).toBeNull();
  });

  test("excludes a tool with an invalid x-mcp-header annotation from the forwarded tools/list", async () => {
    const tools = {
      jsonrpc: "2.0",
      id: 1,
      result: {
        tools: [
          { name: "good", inputSchema: { type: "object", properties: {} } },
          {
            name: "bad",
            inputSchema: {
              type: "object",
              properties: { n: { type: "number", "x-mcp-header": "N" } },
            },
          },
        ],
      },
    };
    stub((req) => noServerStream(req) ?? json(tools));
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      { input: lines({ jsonrpc: "2.0", id: 1, method: "tools/list" }), write: (c) => out.push(c) },
    );

    const frame = framesFrom(out).find((f) => f.id === 1);
    const result = frame?.result as { tools: Array<{ name: string }> };
    expect(result.tools.map((t) => t.name)).toEqual(["good"]);
  });

  test("a 401 after a successful request against a stateless server does not kill the bridge", async () => {
    // 2026-07-28 servers never mint Mcp-Session-Id; "no session yet" must not
    // be the signal for "connection never worked".
    stub((req, postIndex) => {
      const blocked = noServerStream(req);
      if (blocked) return blocked;
      return postIndex === 0
        ? json({ jsonrpc: "2.0", id: 1, result: { tools: [] } })
        : new Response("unauthorized", { status: 401 });
    });
    const out: string[] = [];

    await mcpRun(
      { url: URL },
      {
        input: lines(
          { jsonrpc: "2.0", id: 1, method: "tools/list" },
          { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "t" } },
        ),
        write: (c) => out.push(c),
      },
    );

    const err = framesFrom(out).find((f) => f.id === 2);
    expect((err?.error as { code?: number } | undefined)?.code).toBe(-32001);
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
