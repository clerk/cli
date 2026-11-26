/**
 * MCP server resource URLs: the checks, comparison and derived URLs the
 * connector's `mcp-auth-checker.ts` in clerk/cloudflare-workers
 * (workers/remote-mcp-server/src/mcp-auth-checker.ts) applies. Keep the two in
 * step: the registry and both callers must agree on which URLs are the same.
 */

import { decodePublishableKey } from "../../../lib/fapi.ts";

/**
 * Longest resource URL the registry accepts, in bytes.
 */
const MAX_RESOURCE_URL_BYTES = 2048;

// The registry rejects names longer than 100 bytes.
const MAX_RESOURCE_NAME_LENGTH = 100;

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return true;
  }
  return false;
}

/**
 * Why a value can't be registered as an MCP server URL, worded to follow the
 * URL ("must use https"), or `undefined` when it can.
 *
 * Checks the raw string as well as the parsed URL, because the URL parser
 * silently drops empty fragments and credentials (`https://@host`) and
 * rewrites backslashes and control characters.
 */
export function resourceUrlProblem(value: string): string | undefined {
  if (new TextEncoder().encode(value).length > MAX_RESOURCE_URL_BYTES) {
    return `must be at most ${MAX_RESOURCE_URL_BYTES} bytes`;
  }
  if (hasControlCharacter(value)) return "must not contain control characters";
  if (/\s/u.test(value)) return "must not contain whitespace";
  if (value.includes("\\")) return "must not contain backslashes";
  if (value.includes("#")) return "must not contain a fragment";
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return "must be an absolute URL";
  }
  if (url.protocol !== "https:") return "must use https";
  if (!/^https:\/\/[^/?#]+(?:[/?#]|$)/i.test(value)) return "must be an absolute URL";
  if (url.username || url.password || /^[a-z][a-z0-9+.-]*:\/\/[^/?]*@/i.test(value)) {
    return "must not contain credentials";
  }
  return undefined;
}

/**
 * The form the registry compares resource URLs in, or `undefined` for a URL it
 * would not store.
 *
 * The registry lowercases the scheme and host, drops a port delimiter only when
 * the port is empty or spelled exactly `443`, and keeps the path, query, and
 * trailing slash as given. The authority comes from the raw string, not the URL
 * parser, which would also fold spellings the registry keeps distinct, such as
 * `:0443`.
 */
export function resourceIdentity(value: string): string | undefined {
  const match = /^https:\/\/([^/?#]+)([^?#]*)(\?[^#]*)?$/i.exec(value);
  if (!match) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return undefined;
  const authority = match[1]!.toLowerCase().replace(/:(?:443)?$/, "");
  return `https://${authority}${match[2]}${match[3] ?? ""}`;
}

/**
 * Whether two URLs name the same registered resource.
 */
export function sameResource(a: string, b: string): boolean {
  const left = resourceIdentity(a);
  return left !== undefined && left === resourceIdentity(b);
}

/**
 * The name to register a resource under. The registry requires one; this is
 * host plus path, without the query or a trailing slash, which is what the
 * Dashboard stores for a server it registers.
 */
export function mcpResourceName(uri: string): string {
  const url = new URL(uri);
  return `${url.host}${url.pathname.replace(/\/+$/, "")}`.slice(0, MAX_RESOURCE_NAME_LENGTH);
}

/**
 * Where an MCP server serves its OAuth protected resource metadata: the
 * well-known string inserted between the host and the path (RFC 9728 §3).
 */
export function protectedResourceMetadataUrl(resource: string): string {
  const url = new URL(resource);
  const path = url.pathname === "/" ? "" : url.pathname;
  return `${url.origin}/.well-known/oauth-protected-resource${path}`;
}

/**
 * The instance's issuer, its Frontend API origin, read from its publishable key;
 * `undefined` when the key can't be decoded.
 */
export function issuerFromPublishableKey(publishableKey: string | undefined): string | undefined {
  if (!publishableKey) return undefined;
  try {
    return `https://${decodePublishableKey(publishableKey).fapiHost}`;
  } catch {
    return undefined;
  }
}
