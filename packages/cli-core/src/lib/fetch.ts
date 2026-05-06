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

export type LoggedFetchInit = RequestInit & { tag: string };

export async function loggedFetch(url: URL | string, options: LoggedFetchInit): Promise<Response> {
  const { tag, ...init } = options;
  const method = init.method ?? "GET";
  const urlStr = url.toString();
  log.debug(`${tag}: ${method} ${urlStr}`);
  const proxy = resolveProxy(urlStr);
  const fetchInit = proxy ? { ...init, proxy } : init;
  if (proxy) log.debug(`${tag}: routing via proxy ${redactProxy(proxy)}`);
  const response = await withNetworkAccess(
    { operation: "connect", target: urlStr, label: tag },
    async () => fetch(url, fetchInit),
  );
  if (!response.ok) {
    // Clone so the caller can still consume the body for error construction.
    const body = await response.clone().text();
    log.debug(`${tag}: ${response.status} ${method} ${urlStr} — ${body}`);
  }
  return response;
}

function redactProxy(proxy: string): string {
  try {
    const u = new URL(proxy);
    if (u.username || u.password) {
      u.username = "";
      u.password = "";
      return u.toString();
    }
    return proxy;
  } catch {
    return proxy;
  }
}

/**
 * Resolve a proxy URL for the given target by reading curl-style env vars
 * (HTTPS_PROXY, HTTP_PROXY, NO_PROXY — uppercase or lowercase). Bun's
 * fetch() does not honor these automatically, so we plumb them through the
 * `proxy` option on a per-request basis.
 *
 * Localhost is always skipped so the local OAuth callback listener never
 * gets routed through an external proxy.
 */
function resolveProxy(urlStr: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(urlStr);
  } catch {
    return undefined;
  }
  const host = parsed.hostname;
  if (host === "localhost" || host === "127.0.0.1" || host === "::1") return undefined;
  if (matchesNoProxy(host, env("NO_PROXY"))) return undefined;
  const proxy = parsed.protocol === "http:" ? env("HTTP_PROXY") : env("HTTPS_PROXY");
  return proxy?.trim() || undefined;
}

function env(name: string): string | undefined {
  return process.env[name] ?? process.env[name.toLowerCase()];
}

function matchesNoProxy(host: string, noProxy: string | undefined): boolean {
  if (!noProxy) return false;
  const normalized = host.toLowerCase();
  for (const raw of noProxy.split(",")) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry === "*") return true;
    const suffix = entry.startsWith(".") ? entry : `.${entry}`;
    if (normalized === entry || normalized.endsWith(suffix)) return true;
  }
  return false;
}
