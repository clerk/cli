/**
 * fetch() wrapper that emits consistent debug logs for the request and,
 * on a non-ok response, the response body. The caller still owns error
 * construction and body parsing.
 *
 * All outbound HTTP calls in library code must go through this helper so
 * that `--verbose` surfaces the URL, method, and server response body for
 * every network error. See `.claude/rules/debug-logging.md`.
 */

import { log } from "./log.ts";
import { withNetworkAccess } from "./host-execution.ts";
import { buildUserAgent } from "./user-agent.ts";

const USER_AGENT = buildUserAgent();

/** Native `fetch()` has no timeout, so a stalled connection would hang forever. */
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

export type LoggedFetchInit = RequestInit & { tag: string; timeoutMs?: number };

/**
 * Normalized response shape returned by the higher-level API request wrappers
 * (`bapiRequest`, `fapiRequest`). `body` is the parsed JSON when the payload is
 * valid JSON, otherwise the raw string; `rawBody` is always the unparsed text.
 */
export interface ApiResponse {
  status: number;
  headers: Headers;
  body: unknown;
  rawBody: string;
}

export async function loggedFetch(url: URL | string, options: LoggedFetchInit): Promise<Response> {
  const { tag, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS, signal: callerSignal, ...init } = options;
  const method = init.method ?? "GET";
  const urlStr = url.toString();
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("User-Agent", USER_AGENT);
  log.debug(`${tag}: ${method} ${urlStr}`);

  // A caller signal (e.g. keyless.ts's tighter 15s) composes with our default.
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal ? AbortSignal.any([callerSignal, timeoutSignal]) : timeoutSignal;

  let response: Response;
  try {
    response = await withNetworkAccess(
      { operation: "connect", target: urlStr, label: tag },
      async () => fetch(url, { ...init, headers, signal }),
    );
  } catch (err) {
    // Only relabel when our timeout fired, not a caller abort or network error.
    if (timeoutSignal.aborted && !callerSignal?.aborted) {
      throw new Error(`${tag}: request timed out after ${timeoutMs}ms — ${method} ${urlStr}`);
    }
    throw err;
  }
  if (!response.ok) {
    // Clone so the caller can still consume the body for error construction.
    const body = await response.clone().text();
    log.debug(`${tag}: ${response.status} ${method} ${urlStr} — ${body}`);
  }
  return response;
}
