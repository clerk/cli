/**
 * Pure Svix relay protocol helpers: token generation, URLs, and frame
 * encoding/decoding. Frame field names verified against the svix-cli source.
 * No I/O here — everything is unit-testable without a socket.
 */

export const RELAY_WS_URL = "wss://api.relay.svix.com/api/v1/listen/";

/** Close code the relay sends when another listener holds the same token. */
export const RELAY_CLOSE_TOKEN_COLLISION = 1008;

/**
 * The relay server pings ~every 21s, but Bun's client WebSocket auto-pongs
 * below the JS API (no ping/pong events). After this much silence we actively
 * probe with a client ping — writes to a dead link surface as error/close,
 * which triggers the same-token redial.
 */
export const RELAY_SILENCE_TIMEOUT_MS = 30_000;

export const RELAY_RECONNECT_DELAY_MS = 1_000;

const BASE62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const TOKEN_LENGTH = 10;
// Largest multiple of 62 below 256; bytes at or above it would bias the modulo.
const UNBIASED_BYTE_LIMIT = 248;
// Live-relay verified (2026-06-10): play.svix.com rejects unprefixed tokens
// ("Invalid token"), and the relay only registers an inbox when the start
// frame carries the same c_ token. The prefix is wire format, not cosmetics.
const TOKEN_PREFIX = "c_";

/** `c_` + 10 random base62 chars — the same token goes in the start frame, the inbox URL, and config. */
export function generateRelayToken(): string {
  let token = "";
  while (token.length < TOKEN_LENGTH) {
    const bytes = new Uint8Array(TOKEN_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte >= UNBIASED_BYTE_LIMIT) continue;
      token += BASE62[byte % 62];
      if (token.length === TOKEN_LENGTH) break;
    }
  }
  return TOKEN_PREFIX + token;
}

export function relayReceiveUrl(token: string): string {
  return `https://webhooks.clerk.com/in/${token}/`;
}

export function encodeStartFrame(token: string): string {
  return JSON.stringify({ type: "start", version: 1, data: { token } });
}

export interface RelayEventFrame {
  /** Relay-internal frame ID, echoed back in the response frame. */
  id: string;
  method: string;
  headers: Record<string, string>;
  /** Base64-encoded request body, exactly as received. */
  bodyB64: string;
}

export type DecodedFrame = { type: "event"; event: RelayEventFrame } | { type: "unknown" };

export function decodeFrame(raw: string): DecodedFrame {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { type: "unknown" };
  }
  if (parsed === null || typeof parsed !== "object") return { type: "unknown" };

  const frame = parsed as {
    type?: string;
    data?: { id?: string; method?: string; headers?: Record<string, string>; body?: string };
  };
  if (frame.type !== "event" || !frame.data || typeof frame.data.id !== "string") {
    return { type: "unknown" };
  }

  return {
    type: "event",
    event: {
      id: frame.data.id,
      method: frame.data.method ?? "POST",
      headers: frame.data.headers ?? {},
      bodyB64: frame.data.body ?? "",
    },
  };
}

export function decodeEventBody(event: RelayEventFrame): string {
  return Buffer.from(event.bodyB64, "base64").toString("utf8");
}

/**
 * Frame a forward response back to the relay so Svix-side delivery telemetry
 * stays honest (status, headers, and body of the local handler's response).
 */
export function encodeEventResponseFrame(reply: {
  id: string;
  status: number;
  headers: Record<string, string>;
  bodyB64: string;
}): string {
  return JSON.stringify({
    type: "event",
    version: 1,
    data: { id: reply.id, status: reply.status, headers: reply.headers, body: reply.bodyB64 },
  });
}
