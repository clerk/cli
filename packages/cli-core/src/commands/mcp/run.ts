/**
 * `clerk mcp run` — removed in clerk 4.0.
 *
 * clerk 3.x installed this command into editor configs as a stdio bridge to
 * the Clerk remote MCP server. Every supported client now connects to the
 * server by URL and runs the OAuth sign-in itself, so `clerk mcp install`
 * writes a URL entry instead and the bridge is gone. The command stays
 * (hidden) only so an editor still launching it gets an actionable error
 * rather than "unknown command".
 *
 * Editors often show only protocol-level errors, not stderr, so when the
 * first stdin line is a JSON-RPC request (the client's `initialize`) it is
 * answered with a JSON-RPC error carrying the same message. stdout carries
 * nothing else.
 */

import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { isRecord } from "../../lib/objects.ts";
import { MCP_DOCS_URL } from "./clients/types.ts";

/** Injectable stdin so the stub can be driven in-process by tests. */
interface RunStreams {
  input?: AsyncIterable<Uint8Array | string> | undefined;
}

const REMOVED_MESSAGE =
  "`clerk mcp run` was removed in clerk 4.0. Re-run `clerk mcp install` to switch to the HTTP-based Clerk MCP server.";

// JSON-RPC 2.0 reserves -32000 to -32099 for implementation-defined server errors.
const SERVER_ERROR = -32000;

async function readFirstLine(input: AsyncIterable<Uint8Array | string>): Promise<string> {
  const decoder = new TextDecoder();
  let buffer = "";
  for await (const chunk of input) {
    buffer += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const newline = buffer.indexOf("\n");
    if (newline !== -1) return buffer.slice(0, newline);
  }
  return buffer;
}

function requestId(line: string): string | number | undefined {
  let message: unknown;
  try {
    message = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(message)) return undefined;
  const id = (message as { id?: unknown }).id;
  return typeof id === "string" || typeof id === "number" ? id : undefined;
}

export async function mcpRun(streams: RunStreams = {}): Promise<void> {
  // An interactive terminal never sends a request; don't wait on it.
  const input =
    "input" in streams ? streams.input : process.stdin.isTTY ? undefined : process.stdin;
  const id = input === undefined ? undefined : requestId(await readFirstLine(input));
  if (id !== undefined) {
    log.data(
      JSON.stringify({
        jsonrpc: "2.0",
        id,
        error: { code: SERVER_ERROR, message: REMOVED_MESSAGE },
      }),
    );
  }
  throw new CliError(REMOVED_MESSAGE, {
    code: ERROR_CODE.MCP_BRIDGE_REMOVED,
    docsUrl: MCP_DOCS_URL,
  });
}
