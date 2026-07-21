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
import { isRecord } from "../../lib/objects.ts";
import { resolveUrl, type McpOptions } from "./shared.ts";

/** Injectable streams so the bridge can be driven in-process by tests. */
interface RunStreams {
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
    // Swallow write errors (e.g. EPIPE) so one failed frame doesn't wedge the chain.
    writeTail = writeTail
      .then(() => writeRaw(line))
      .catch((err: unknown) => {
        log.debug(`mcp run: write error — ${errorMessage(err)}`);
      });
    return writeTail;
  };

  // MCP allows batch responses as a top-level JSON array; fan each item out as
  // its own frame, dropping anything that isn't a routable JSON-RPC object.
  const emitPayload = async (parsed: unknown): Promise<void> => {
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) {
      if (isRecord(item)) await emit(item);
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
  const resetServerStream = (): void => {
    serverStream = undefined;
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
        resetServerStream,
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
  resetServerStream: () => void;
  signal: AbortSignal;
}

async function dispatch(message: JsonRpcMessage, ctx: DispatchCtx): Promise<void> {
  const { url, session, emit, emitPayload, track, ensureServerStream, resetServerStream, signal } =
    ctx;
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

  // Before a session exists the server needs up-front auth we can't provide —
  // fail clearly. After `initialize`, a scoped 401 is a per-request error, not
  // a reason to kill the bridge and every other in-flight request with it.
  const needsAuth = response.status === 401 || response.status === 403;
  if (needsAuth && session.id === undefined) {
    throw new CliError(
      `The MCP server at ${url} requires authentication, which \`clerk mcp run\` does not yet provide. ` +
        "Set CLERK_MCP_URL to a server that doesn't require auth, or wait for a release with built-in sign-in.",
      { code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID },
    );
  }
  if (needsAuth) {
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
  // Also drop the server→client stream tied to the old session — otherwise
  // `ensureServerStream()` short-circuits on the next `initialize` and the new
  // session never reopens its GET/SSE channel (the `suppress(...)` wrapper
  // already makes a second GET safe).
  if (response.status === 404 && session.id) {
    session.id = undefined;
    session.protocolVersion = undefined;
    resetServerStream();
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
    // If the stream dies before this request's response frame arrives, answer
    // with a JSON-RPC error so the client doesn't hang on the request forever.
    // `replied` guards the case where the response was already delivered and a
    // later event errors — a second reply for the same id would be a protocol
    // violation. Notifications (no id) never need a reply.
    let replied = message.id === undefined;
    const markReplied: Emit = async (parsed) => {
      if (!replied && hasReplyFor(parsed, message.id)) replied = true;
      await emitPayload(parsed);
    };
    track(
      pipeEventStream(response, markReplied, {
        signal,
        onStreamError: async (error) => {
          if (replied) return;
          await emitError(message, emit, -32000, `Upstream stream failed: ${errorMessage(error)}`);
        },
      }),
    );
    return;
  }
  // The initialize response body is drained concurrently via track(); the
  // protocol version captured inside emitPayload→emit is set before the next
  // request fires because the MCP client awaits the initialize reply.
  track(forwardJsonBody(response, message, emit, emitPayload));
}

/** True when any frame in the payload answers the request with this id. */
function hasReplyFor(parsed: unknown, id: JsonRpcMessage["id"]): boolean {
  return (Array.isArray(parsed) ? parsed : [parsed]).some(
    (item) => isRecord(item) && (item as JsonRpcMessage).id === id,
  );
}

/**
 * Read a response body as text, or `undefined` once it exceeds `maxBytes` —
 * the JSON-body counterpart of the SSE buffer cap: the upstream server is a
 * trust boundary and must not be able to grow the bridge's memory unbounded.
 */
export async function readTextCapped(
  response: Response,
  maxBytes: number,
): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return "";
  const decoder = new TextDecoder();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += decoder.decode(value, { stream: true });
    if (text.length > maxBytes) {
      await reader.cancel().catch(() => {});
      return undefined;
    }
  }
  return text + decoder.decode();
}

async function forwardJsonBody(
  response: Response,
  message: JsonRpcMessage,
  emit: Emit,
  emitPayload: Emit,
): Promise<void> {
  const text = await readTextCapped(response, MAX_LINE_BYTES);
  if (text === undefined) {
    await emitError(message, emit, -32000, "Upstream response too large.");
    return;
  }
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
  if (!isRecord(message)) return;
  const result = (message as { result?: unknown }).result;
  if (!isRecord(result)) return;
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
    await pipeEventStream(response, emitPayload, { signal });
  }
}

/** Read newline-delimited JSON-RPC frames from a byte/string stream. */
async function* readJsonRpcLines(
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
  // Flush the decoder so a trailing multi-byte character split at the final
  // chunk boundary isn't silently dropped from the last line.
  buffer += decoder.decode();
  const parsed = parseLine(buffer.trim());
  if (parsed) yield parsed;
}

function parseLine(line: string): JsonRpcMessage | undefined {
  if (line.length === 0) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    log.warn(`mcp run: ignoring non-JSON line on stdin`);
    return undefined;
  }
  // Mirrors the outgoing-frame guard in emitPayload: a bare scalar or array is
  // valid JSON but not a JSON-RPC message, and must not be forwarded upstream.
  if (!isRecord(parsed)) {
    log.warn(`mcp run: ignoring non-object frame on stdin`);
    return undefined;
  }
  return parsed as JsonRpcMessage;
}

interface PipeEventStreamOptions {
  signal?: AbortSignal;
  onStreamError?: (error: unknown) => Promise<void>;
  maxBufferBytes?: number;
}

/** Parse an SSE stream, emitting each event's JSON `data:` payload. */
export async function pipeEventStream(
  response: Response,
  emitPayload: Emit,
  options: PipeEventStreamOptions = {},
): Promise<void> {
  const { signal, onStreamError, maxBufferBytes = MAX_LINE_BYTES } = options;
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
      // This stream can be process-lifetime (the server→client GET stream), so
      // an upstream that never sends an event boundary must not accumulate
      // forever — mirror the stdin path's oversized-line discard.
      if (buffer.length > maxBufferBytes) {
        log.warn("mcp run: discarding oversized SSE event buffer");
        buffer = "";
      }
    }
    // Flush the decoder: a multi-byte character split at the final chunk
    // boundary is held in internal state and would otherwise be dropped.
    buffer += decoder.decode().replace(EOL, "\n");
    await emitEvent(buffer, emitPayload);
  } catch (error) {
    // A drain cut short by shutdown is expected; a live stream dying is not —
    // surface it under --verbose and let the caller answer the waiting request.
    if (signal?.aborted) return;
    log.debug(`mcp run: SSE stream error — ${errorMessage(error)}`);
    await onStreamError?.(error);
  } finally {
    // `{ once: true }` only self-removes if abort fires; on the normal path the
    // listener would otherwise accumulate on the process-lifetime signal.
    signal?.removeEventListener("abort", cancel);
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
