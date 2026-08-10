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
import { optOutEnvVar } from "./env-signals.ts";
import { getTelemetryDisabled } from "./config.ts";

let userAgentPromise: Promise<string> | undefined;

/** Test-only: recompute the User-Agent on the next request. */
export function _resetUserAgentCache(): void {
  userAgentPromise = undefined;
}

function resolveUserAgent(): Promise<string> {
  // The AIAgent segment exists purely for analytics classification, so it
  // honors the telemetry opt-outs (env vars and `clerk telemetry disable`).
  userAgentPromise ??= (async () => {
    const optedOut =
      optOutEnvVar(process.env) !== null || (await getTelemetryDisabled().catch(() => true));
    return buildUserAgent(process.env, { agentToken: !optedOut });
  })();
  return userAgentPromise;
}

export type LoggedFetchInit = RequestInit & { tag: string; bestEffort?: boolean };

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
  const { tag, bestEffort, ...init } = options;
  const method = init.method ?? "GET";
  const urlStr = url.toString();
  const headers = new Headers(init.headers);
  if (!headers.has("user-agent")) headers.set("User-Agent", await resolveUserAgent());
  log.debug(`${tag}: ${method} ${urlStr}`);
  const response = await withNetworkAccess(
    { operation: "connect", target: urlStr, label: tag, bestEffort },
    async () => fetch(url, { ...init, headers }),
  );
  if (!response.ok) {
    // Clone so the caller can still consume the body for error construction.
    const body = await response.clone().text();
    log.debug(`${tag}: ${response.status} ${method} ${urlStr} — ${body}`);
  }
  return response;
}
