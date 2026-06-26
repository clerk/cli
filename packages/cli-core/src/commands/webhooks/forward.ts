import { errorMessage, throwUsageError } from "../../lib/errors.ts";
import { loggedFetch } from "../../lib/fetch.ts";

export interface ForwardOutcome {
  status: number;
  headers: Record<string, string>;
  bodyText: string;
  bodyB64: string;
  latencyMs: number;
  /** True when the local handler was unreachable (status is a synthetic 502). */
  failed: boolean;
}

/**
 * Hop-by-hop headers that must not be forwarded to the target. These are
 * meaningful only for the single transport hop and would confuse the target
 * server or cause protocol violations (e.g. chunked encoding mismatch).
 */
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailers",
  "transfer-encoding",
  "upgrade",
  "host",
]);

/**
 * Parse one `--header` value (`key:value`, split on the FIRST colon, whitespace
 * trimmed) into a [key, value] pair. Throws a usage error on malformed input.
 */
export function parseHeaderFlag(value: string): [string, string] {
  const colonIndex = value.indexOf(":");
  const key = colonIndex === -1 ? "" : value.slice(0, colonIndex).trim();
  if (!key) {
    throwUsageError(`Invalid --header "${value}". Expected key:value (e.g. --header x-env:dev).`);
  }
  return [key, value.slice(colonIndex + 1).trim()];
}

/**
 * Delivery headers plus `--header` extras, with hop-by-hop headers stripped.
 * Extras may override non-svix delivery headers, but the delivery's `svix-*`
 * headers always win — they are what `verify` (and the user's handler)
 * authenticate against.
 */
export function buildForwardHeaders(
  eventHeaders: Record<string, string>,
  extraHeaders: Headers,
): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(eventHeaders)) {
    if (HOP_BY_HOP_HEADERS.has(key.toLowerCase())) continue;
    headers.set(key, value);
  }
  const seenExtra = new Set<string>();
  for (const [key, value] of extraHeaders) {
    const lower = key.toLowerCase();
    if (lower.startsWith("svix-")) continue;
    if (seenExtra.has(lower)) {
      headers.append(key, value);
    } else {
      headers.set(key, value);
      seenExtra.add(lower);
    }
  }
  return headers;
}

export async function forwardDelivery(args: {
  forwardTo: string;
  method: string;
  headers: Headers;
  body: string;
}): Promise<ForwardOutcome> {
  const startedAt = performance.now();
  try {
    const response = await loggedFetch(args.forwardTo, {
      tag: "relay",
      method: args.method,
      headers: args.headers,
      body: args.body,
      signal: AbortSignal.timeout(30_000),
    });
    const bodyText = await response.text();
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key] = value;
    });
    return {
      status: response.status,
      headers,
      bodyText,
      bodyB64: Buffer.from(bodyText, "utf8").toString("base64"),
      latencyMs: Math.round(performance.now() - startedAt),
      failed: false,
    };
  } catch (error) {
    // Local handler unreachable. Frame a synthetic 502 back so Svix-side
    // delivery telemetry records the failure instead of a hung attempt.
    const message = errorMessage(error);
    return {
      status: 502,
      headers: {},
      bodyText: message,
      bodyB64: Buffer.from(message, "utf8").toString("base64"),
      latencyMs: Math.round(performance.now() - startedAt),
      failed: true,
    };
  }
}
