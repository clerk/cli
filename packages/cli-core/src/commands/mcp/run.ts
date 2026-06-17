/**
 * `clerk mcp run` — a stdio bridge to the Clerk remote MCP server.
 *
 * AI clients that launch an MCP server as a subprocess speak newline-delimited
 * JSON-RPC over stdio. This command forwards that stream to the remote server
 * over the Streamable HTTP transport (POST per message, SSE or JSON responses)
 * and writes replies back to stdout — the same job `npx mcp-remote` does, but
 * built into the CLI so it's installed without npx and can become auth-aware
 * later without a re-install.
 *
 * Transport-only: an auth-required server surfaces an error rather than running
 * an OAuth flow (that lands in a follow-up against this same command).
 *
 * stdout carries ONLY JSON-RPC frames — every diagnostic goes to stderr via
 * `log.*`. A stray write to stdout corrupts the channel and breaks the client.
 */

import { CliError, ERROR_CODE, errorMessage } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";
import { log } from "../../lib/log.ts";
import { resolveUrl, type McpOptions } from "./shared.ts";

/** Injectable streams so the bridge can be driven in-process by tests. */
export interface RunStreams {
  input?: AsyncIterable<Uint8Array | string>;
  write?: (chunk: string) => void;
}

type JsonRpcMessage = { id?: string | number; method?: string; result?: unknown };
type Session = { id?: string; protocolVersion?: string };
type Emit = (message: unknown) => Promise<void>;

const SESSION_HEADER = "mcp-session-id";
// Cap an unterminated stdin line so a misbehaving client can't grow the buffer
// without bound. MCP frames are small; 16 MiB is far above any real message.
const MAX_LINE_BYTES = 16 * 1024 * 1024;
// Normalize CRLF and bare CR to LF so SSE event boundaries (`\n\n`) always match.
const EOL = /\r\n?/g;

export async function mcpRun(options: McpOptions = {}, streams: RunStreams = {}): Promise<void> {
  const url = resolveUrl(options);
  const input = streams.input ?? process.stdin;
  const writeRaw = streams.write ?? ((chunk: string) => void process.stdout.write(chunk));

  const session: Session = {};

  // Serialize stdout writes: concurrent SSE drains and the server→client stream
  // all emit, and a frame must never interleave with another.
  let writeTail: Promise<void> = Promise.resolve();
  const emit: Emit = (message) => {
    captureProtocolVersion(message, session);
    const line = JSON.stringify(message) + "\n";
    writeTail = writeTail.then(() => writeRaw(line));
    return writeTail;
  };

  // MCP allows batch responses as a top-level JSON array; fan each item out as
  // its own frame, dropping anything that isn't a routable JSON-RPC object.
  const emitPayload = async (parsed: unknown): Promise<void> => {
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (typeof item === "object" && item !== null && !Array.isArray(item)) await emit(item);
      else log.warn("mcp run: dropping non-object frame from upstream");
    }
  };

  const abort = new AbortController();
  // A drain that ends because we're shutting down is expected; anything else is
  // a real (non-fatal) error worth surfacing under --verbose.
  const suppress = (work: Promise<void>): Promise<void> =>
    work.catch((error: unknown) => {
      if (!abort.signal.aborted)
        log.debug(`mcp run: response drain error — ${errorMessage(error)}`);
    });

  // Bodies (SSE streams and slow JSON) drain concurrently so one long response
  // never blocks the next request — head-of-line free.
  const inflight = new Set<Promise<void>>();
  const track = (work: Promise<void>): void => {
    const p = suppress(work).finally(() => inflight.delete(p));
    inflight.add(p);
  };

  let serverStream: Promise<void> | undefined;
  const ensureServerStream = (): void => {
    if (serverStream) return;
    serverStream = suppress(listenForServerMessages(url, session, emitPayload, abort.signal));
  };

  try {
    for await (const message of readJsonRpcLines(input, MAX_LINE_BYTES)) {
      await dispatch(message, {
        url,
        session,
        emit,
        emitPayload,
        track,
        ensureServerStream,
        signal: abort.signal,
      });
    }
  } finally {
    abort.abort();
    await Promise.allSettled([...inflight, serverStream]);
    await writeTail;
  }
}

interface DispatchCtx {
  url: string;
  session: Session;
  emit: Emit;
  emitPayload: Emit;
  track: (work: Promise<void>) => void;
  ensureServerStream: () => void;
  signal: AbortSignal;
}

async function dispatch(message: JsonRpcMessage, ctx: DispatchCtx): Promise<void> {
  const { url, session, emit, emitPayload, track, ensureServerStream, signal } = ctx;
  let response: Response;
  try {
    response = await loggedFetch(url, {
      tag: "mcp",
      method: "POST",
      headers: requestHeaders(session),
      body: JSON.stringify(message),
      signal,
    });
  } catch (error) {
    if (signal.aborted) return;
    log.warn(`mcp run: request failed — ${errorMessage(error)}`);
    await emitError(message, emit, -32000, `Upstream request failed: ${errorMessage(error)}`);
    return;
  }

  const newSession = response.headers.get(SESSION_HEADER);
  if (newSession) {
    session.id = newSession;
    ensureServerStream();
  }

  if (response.status === 401 || response.status === 403) {
    // Before a session exists the server needs up-front auth we can't provide —
    // fail clearly. After `initialize`, a scoped 401 is a per-request error, not
    // a reason to kill the bridge and every other in-flight request with it.
    if (session.id === undefined) {
      throw new CliError(
        `The MCP server at ${url} requires authentication, which \`clerk mcp run\` does not yet provide. ` +
          "Point --url at a server that doesn't require auth, or wait for a release with built-in sign-in.",
        { code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID },
      );
    }
    await emitError(
      message,
      emit,
      -32001,
      "The MCP server requires authentication for this request.",
    );
    return;
  }

  // A stale session id returns 404; drop session state and let the client
  // re-initialize (the next session may negotiate a different protocol version).
  if (response.status === 404 && session.id) {
    session.id = undefined;
    session.protocolVersion = undefined;
    await emitError(message, emit, -32001, "MCP session expired — reinitialize the connection.");
    return;
  }

  // Notifications and responses the server merely accepts carry no body.
  if (response.status === 202 || response.status === 204) return;

  if (!response.ok) {
    await emitError(message, emit, -32000, `Upstream returned HTTP ${response.status}.`);
    return;
  }

  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
    track(pipeEventStream(response, emitPayload, signal));
    return;
  }
  track(forwardJsonBody(response, message, emit, emitPayload));
}

async function forwardJsonBody(
  response: Response,
  message: JsonRpcMessage,
  emit: Emit,
  emitPayload: Emit,
): Promise<void> {
  const text = await response.text();
  if (text.trim().length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    await emitError(message, emit, -32000, "Upstream returned a non-JSON response.");
    return;
  }
  await emitPayload(parsed);
}

async function emitError(
  message: JsonRpcMessage,
  emit: Emit,
  code: number,
  text: string,
): Promise<void> {
  // Only requests (with an id) expect a reply; notifications don't.
  if (message.id === undefined) return;
  await emit({ jsonrpc: "2.0", id: message.id, error: { code, message: text } });
}

function requestHeaders(session: Session): Record<string, string> {
  return {
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    ...sessionHeaders(session),
  };
}

function sessionHeaders(session: Session): Record<string, string> {
  const headers: Record<string, string> = {};
  if (session.id) headers["Mcp-Session-Id"] = session.id;
  if (session.protocolVersion) headers["MCP-Protocol-Version"] = session.protocolVersion;
  return headers;
}

// The negotiated protocol version is echoed on every subsequent request header.
// It comes from the (untrusted) server body, so reject anything with control
// chars — a CRLF would otherwise inject headers or wedge every later request.
function captureProtocolVersion(message: unknown, session: Session): void {
  if (typeof message !== "object" || message === null) return;
  const result = (message as { result?: unknown }).result;
  if (typeof result !== "object" || result === null) return;
  const version = (result as { protocolVersion?: unknown }).protocolVersion;
  if (typeof version === "string" && /^[\x20-\x7e]+$/.test(version)) {
    session.protocolVersion = version;
  }
}

// Open the optional GET stream for server-initiated messages. Servers that
// don't support it answer non-2xx; treat that as "nothing to stream".
async function listenForServerMessages(
  url: string,
  session: Session,
  emitPayload: Emit,
  signal: AbortSignal,
): Promise<void> {
  const response = await loggedFetch(url, {
    tag: "mcp",
    method: "GET",
    headers: { Accept: "text/event-stream", ...sessionHeaders(session) },
    signal,
  });
  if (!response.ok) return;
  if ((response.headers.get("content-type") ?? "").includes("text/event-stream")) {
    await pipeEventStream(response, emitPayload, signal);
  }
}

/** Read newline-delimited JSON-RPC frames from a byte/string stream. */
export async function* readJsonRpcLines(
  input: AsyncIterable<Uint8Array | string>,
  maxLineBytes = MAX_LINE_BYTES,
): AsyncGenerator<JsonRpcMessage, void, undefined> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      const parsed = parseLine(line);
      if (parsed) yield parsed;
    }
    if (buffer.length > maxLineBytes) {
      log.warn("mcp run: discarding oversized stdin line");
      buffer = "";
    }
  }
  const parsed = parseLine(buffer.trim());
  if (parsed) yield parsed;
}

function parseLine(line: string): JsonRpcMessage | undefined {
  if (line.length === 0) return undefined;
  try {
    return JSON.parse(line) as JsonRpcMessage;
  } catch {
    log.warn(`mcp run: ignoring non-JSON line on stdin`);
    return undefined;
  }
}

/** Parse an SSE stream, emitting each event's JSON `data:` payload. */
export async function pipeEventStream(
  response: Response,
  emitPayload: Emit,
  signal?: AbortSignal,
): Promise<void> {
  const reader = response.body?.getReader();
  if (!reader) return;
  // Belt-and-suspenders cancel on shutdown so a never-closing stream can't pin
  // the process even if the fetch signal doesn't propagate to the body reader.
  const cancel = () => void reader.cancel().catch(() => {});
  if (signal?.aborted) cancel();
  else signal?.addEventListener("abort", cancel, { once: true });
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(EOL, "\n");
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) !== -1) {
        await emitEvent(buffer.slice(0, boundary), emitPayload);
        buffer = buffer.slice(boundary + 2);
      }
    }
    await emitEvent(buffer, emitPayload);
  } catch {
    // Aborted on shutdown or the stream errored — nothing more to drain.
  }
}

async function emitEvent(rawEvent: string, emitPayload: Emit): Promise<void> {
  const data = rawEvent
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
  if (data.length === 0) return;
  try {
    await emitPayload(JSON.parse(data));
  } catch {
    log.warn(`mcp run: ignoring malformed SSE data frame`);
  }
}
