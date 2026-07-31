/**
 * Dual-era MCP handshake probe.
 *
 * Implements the 2026-07-28 backward-compatibility algorithm: attempt a
 * modern `server/discover` first, and on failure inspect the body — a
 * recognized modern JSON-RPC error (-32020..-32022) proves a modern server
 * (retry with an advertised version, never fall back), while anything else
 * falls back to the legacy `initialize` handshake so pre-2026 servers keep
 * probing correctly. Used by the `clerk doctor` MCP health check. Returns a
 * result rather than throwing so the caller can fold it into a `CheckResult`.
 */

import { isRecord } from "../../lib/objects.ts";
import { errorMessage } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";
import { log } from "../../lib/log.ts";
import { DEV_CLI_VERSION, resolveCliVersion } from "../../lib/version.ts";
import {
  META_CLIENT_CAPABILITIES,
  META_CLIENT_INFO,
  META_PROTOCOL_VERSION,
  META_SERVER_INFO,
  MCP_ERROR_CODE,
  MODERN_PROTOCOL_VERSION,
  isHeaderSafe,
  isModernErrorCode,
} from "./headers.ts";
import { sseEventData } from "./sse.ts";
// Type-only: erased at compile, so the SDK stays a devDependency and is never
// bundled — it exists purely as a TS gate keeping this request spec-valid.
import type { InitializeRequest, JSONRPCRequest } from "@modelcontextprotocol/sdk/types.js";

// Discriminated on `ok`: a healthy probe always carries a server name; a failed
// one never does. "ok but no serverName" is unrepresentable. `authRequired`
// marks a 401/403 answer: the server is demonstrably there, it just gates the
// handshake behind auth we don't send — callers should report "reachable,
// requires authentication" rather than "not reachable".
export type McpProbeResult =
  | { ok: true; status: number; serverName: string }
  | { ok: false; status?: number; error?: string; authRequired?: boolean };

// A hostile or wrong URL shouldn't hang the CLI: cap each probe request so a
// slow or never-ending response surfaces as a failure instead of blocking
// forever. 5s covers a cold-start server while keeping `clerk doctor` snappy
// on a dead one.
const PROBE_TIMEOUT_MS = 5_000;

const CLIENT_INFO = {
  name: "clerk-cli",
  version: resolveCliVersion() ?? DEV_CLI_VERSION,
};

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: CLIENT_INFO,
  },
} satisfies JSONRPCRequest & InitializeRequest;

// Modern requests are stateless: no handshake, the version and capabilities
// ride in `_meta` on every request — and must match the HTTP headers.
function discoverRequest(protocolVersion: string): JSONRPCRequest {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "server/discover",
    params: {
      _meta: {
        [META_PROTOCOL_VERSION]: protocolVersion,
        [META_CLIENT_INFO]: CLIENT_INFO,
        [META_CLIENT_CAPABILITIES]: {},
      },
    },
  };
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The streamable-HTTP transport answers a handshake as either application/json
// or a text/event-stream frame (`event: message\ndata: {…}`). Pull the JSON-RPC
// payload out of whichever the server returned. For SSE, reassemble the first
// event's `data:` lines (the spec allows a payload to span several).
function parseHandshake(contentType: string, body: string): unknown {
  if (!contentType.includes("text/event-stream")) return safeJsonParse(body);
  const firstEvent = body.split(/\r?\n\r?\n/)[0] ?? "";
  const data = sseEventData(firstEvent);
  return data === "" ? undefined : safeJsonParse(data);
}

// Strip control chars so a server-supplied name can't smuggle terminal escape
// sequences into `doctor` output.
function stripControl(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (code >= 0x20 && code !== 0x7f) out += char;
  }
  return out;
}

// A valid legacy `initialize` result carries `serverInfo.name`; its presence is
// what distinguishes a real MCP server from a URL that merely returns 200.
function readLegacyServerName(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const result = payload.result;
  if (!isRecord(result)) return undefined;
  const serverInfo = result.serverInfo;
  if (!isRecord(serverInfo)) return undefined;
  const name = serverInfo.name;
  return typeof name === "string" ? stripControl(name) : undefined;
}

// A modern `DiscoverResult` is identified by its required `supportedVersions`
// list; identity lives in `_meta` and is only SHOULD-required, so a missing
// name still reads as a healthy server.
function readDiscoverServerName(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const result = payload.result;
  if (!isRecord(result) || !Array.isArray(result.supportedVersions)) return undefined;
  const meta = result._meta;
  const serverInfo = isRecord(meta) ? meta[META_SERVER_INFO] : undefined;
  const name = isRecord(serverInfo) ? serverInfo.name : undefined;
  return typeof name === "string" ? stripControl(name) : "unnamed MCP server";
}

// The modern JSON-RPC error inside a response body, when there is one.
type ModernError = { code: number; message: string; supported: string[] };

function readModernError(payload: unknown): ModernError | undefined {
  if (!isRecord(payload)) return undefined;
  const error = payload.error;
  if (!isRecord(error) || typeof error.code !== "number") return undefined;
  if (!isModernErrorCode(error.code)) return undefined;
  const data = isRecord(error.data) ? error.data : {};
  const supported = Array.isArray(data.supported)
    ? data.supported.filter((v): v is string => typeof v === "string" && isHeaderSafe(v))
    : [];
  return {
    code: error.code,
    message: typeof error.message === "string" ? stripControl(error.message) : "MCP error",
    supported,
  };
}

// One POST leg of the probe, with outcomes the decision table branches on.
type Attempt =
  | { kind: "ok"; status: number; payload: unknown }
  | { kind: "auth"; status: number }
  | { kind: "http-error"; status: number; payload: unknown }
  | { kind: "network"; error: string };

async function post(url: string, body: JSONRPCRequest, headers: Record<string, string>) {
  return loggedFetch(url, {
    tag: "mcp",
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
}

async function attempt(
  url: string,
  body: JSONRPCRequest,
  headers: Record<string, string>,
): Promise<Attempt> {
  let response: Response;
  try {
    response = await post(url, body, headers);
  } catch (error) {
    return { kind: "network", error: errorMessage(error) };
  }
  // An auth-gated server answered — it's demonstrably there, it just gates the
  // handshake behind auth this probe deliberately doesn't send (editors run
  // their own OAuth flow).
  if (response.status === 401 || response.status === 403) {
    return { kind: "auth", status: response.status };
  }
  const contentType = response.headers.get("content-type") ?? "";
  const payload = parseHandshake(contentType, await response.text());
  if (!response.ok) return { kind: "http-error", status: response.status, payload };
  return { kind: "ok", status: response.status, payload };
}

async function probeDiscover(url: string, protocolVersion: string): Promise<Attempt> {
  return attempt(url, discoverRequest(protocolVersion), {
    "MCP-Protocol-Version": protocolVersion,
    "Mcp-Method": "server/discover",
  });
}

// The pre-2026 handshake, kept as the fallback leg for legacy-only servers.
async function probeLegacy(url: string): Promise<McpProbeResult> {
  const result = await attempt(url, INITIALIZE_REQUEST, {});
  switch (result.kind) {
    case "network":
      return { ok: false, error: result.error };
    case "auth":
      return { ok: false, status: result.status, authRequired: true };
    case "http-error":
      return { ok: false, status: result.status };
    case "ok": {
      const serverName = readLegacyServerName(result.payload);
      if (serverName === undefined) {
        return { ok: false, status: result.status, error: "no MCP initialize result" };
      }
      return { ok: true, status: result.status, serverName };
    }
  }
}

export async function probeMcp(url: string): Promise<McpProbeResult> {
  const discover = await probeDiscover(url, MODERN_PROTOCOL_VERSION);
  if (discover.kind === "network") return { ok: false, error: discover.error };
  if (discover.kind === "auth") {
    return { ok: false, status: discover.status, authRequired: true };
  }

  if (discover.kind === "ok") {
    const serverName = readDiscoverServerName(discover.payload);
    if (serverName !== undefined) {
      log.debug(`mcp: ${url} answered server/discover — modern era`);
      return { ok: true, status: discover.status, serverName };
    }
    // 200 but not a DiscoverResult: either a legacy server answering the
    // unknown method with a JSON-RPC error, or not an MCP server at all —
    // both resolve on the legacy leg.
    log.debug(`mcp: ${url} returned 200 without a DiscoverResult — trying legacy initialize`);
    return probeLegacy(url);
  }

  // The spec's body inspection is defined for 400 Bad Request only: on any
  // other status (a proxy 5xx page, a legacy 404/405) a body that happens to
  // contain a reserved MCP error code proves nothing.
  const modernError = discover.status === 400 ? readModernError(discover.payload) : undefined;
  // No recognized modern error — the spec's signal for a legacy server (or a
  // proxy error page). Fall back to `initialize`.
  if (modernError === undefined) {
    log.debug(
      `mcp: ${url} rejected server/discover (HTTP ${discover.status}, no modern error body) — trying legacy initialize`,
    );
    return probeLegacy(url);
  }

  // A modern server rejected the probe; never fall back — `initialize` is not
  // part of the modern era.
  log.debug(`mcp: ${url} answered with modern error ${modernError.code} — modern era`);
  // The probe can't know what capability the server wants, so like 401/403 a
  // capability rejection reads as "demonstrably there, just gated" — healthy.
  if (modernError.code === MCP_ERROR_CODE.MISSING_REQUIRED_CLIENT_CAPABILITY) {
    return { ok: true, status: discover.status, serverName: "unnamed MCP server" };
  }
  // If it advertised versions we can name, retry once with its first choice;
  // otherwise surface its error.
  const retryVersion = modernError.supported.find((v) => v !== MODERN_PROTOCOL_VERSION);
  if (modernError.code === MCP_ERROR_CODE.UNSUPPORTED_PROTOCOL_VERSION && retryVersion) {
    const retry = await probeDiscover(url, retryVersion);
    if (retry.kind === "auth") return { ok: false, status: retry.status, authRequired: true };
    if (retry.kind === "ok") {
      const serverName = readDiscoverServerName(retry.payload);
      if (serverName !== undefined) return { ok: true, status: retry.status, serverName };
    }
  }
  return { ok: false, status: discover.status, error: modernError.message };
}
