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

/** Comma-separated `k:v` pairs, split on the FIRST colon, whitespace trimmed. */
export function parseHeaderPairs(value: string | undefined): Record<string, string> {
  if (!value) return {};
  const headers: Record<string, string> = {};
  for (const pair of value.split(",")) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const colonIndex = trimmed.indexOf(":");
    const key = colonIndex === -1 ? "" : trimmed.slice(0, colonIndex).trim();
    if (!key) {
      throwUsageError(`Invalid --headers pair "${trimmed}". Expected key:value.`);
    }
    headers[key] = trimmed.slice(colonIndex + 1).trim();
  }
  return headers;
}

/**
 * Delivery headers plus `--headers` extras. Extras may override non-svix
 * delivery headers, but the delivery's `svix-*` headers always win — they are
 * what `verify` (and the user's handler) authenticate against.
 */
export function buildForwardHeaders(
  eventHeaders: Record<string, string>,
  extraHeaders: Record<string, string>,
): Headers {
  const headers = new Headers(eventHeaders);
  for (const [key, value] of Object.entries(extraHeaders)) {
    if (key.toLowerCase().startsWith("svix-")) continue;
    headers.set(key, value);
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
