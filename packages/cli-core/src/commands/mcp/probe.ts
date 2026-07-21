/**
 * MCP `initialize` handshake probe.
 *
 * Performs the JSON-RPC `initialize` call every MCP client makes and confirms
 * the server answers with a result carrying `serverInfo` — the actual MCP
 * contract, independent of any OAuth-metadata side channel. Used by the
 * `clerk doctor` MCP health check. Returns a result rather than throwing so the
 * caller can fold it into a `CheckResult`.
 */

import { isRecord } from "../../lib/objects.ts";
import { errorMessage } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";
import { DEV_CLI_VERSION, resolveCliVersion } from "../../lib/version.ts";

// Discriminated on `ok`: a healthy probe always carries a server name; a failed
// one never does. "ok but no serverName" is unrepresentable.
export type McpProbeResult =
  | { ok: true; status: number; serverName: string }
  | { ok: false; status?: number; error?: string };

// A hostile or wrong URL shouldn't hang the CLI: cap the probe so a slow or
// never-ending response surfaces as a failure instead of blocking forever.
// 5s covers a cold-start server while keeping `clerk doctor` snappy on a dead one.
const PROBE_TIMEOUT_MS = 5_000;

const INITIALIZE_REQUEST = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "clerk-cli", version: resolveCliVersion() ?? DEV_CLI_VERSION },
  },
};

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// The streamable-HTTP transport answers `initialize` as either application/json
// or a text/event-stream frame (`event: message\ndata: {…}`). Pull the JSON-RPC
// payload out of whichever the server returned. For SSE, reassemble the first
// event's `data:` lines (the spec allows a payload to span several).
function parseHandshake(contentType: string, body: string): unknown {
  if (!contentType.includes("text/event-stream")) return safeJsonParse(body);
  const firstEvent = body.split(/\r?\n\r?\n/)[0] ?? "";
  const data = firstEvent
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trim())
    .join("\n");
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

// A valid `initialize` result carries `serverInfo.name`; its presence is what
// distinguishes a real MCP server from a URL that merely returns 200.
function readServerName(payload: unknown): string | undefined {
  if (!isRecord(payload)) return undefined;
  const result = (payload as { result?: unknown }).result;
  if (!isRecord(result)) return undefined;
  const serverInfo = (result as { serverInfo?: unknown }).serverInfo;
  if (!isRecord(serverInfo)) return undefined;
  const name = (serverInfo as { name?: unknown }).name;
  return typeof name === "string" ? stripControl(name) : undefined;
}

export async function probeMcp(url: string): Promise<McpProbeResult> {
  try {
    const response = await loggedFetch(url, {
      tag: "mcp",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify(INITIALIZE_REQUEST),
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return { ok: false, status: response.status };

    const contentType = response.headers.get("content-type") ?? "";
    const serverName = readServerName(parseHandshake(contentType, await response.text()));
    if (serverName === undefined) {
      return { ok: false, status: response.status, error: "no MCP initialize result" };
    }
    return { ok: true, status: response.status, serverName };
  } catch (error) {
    return { ok: false, error: errorMessage(error) };
  }
}
