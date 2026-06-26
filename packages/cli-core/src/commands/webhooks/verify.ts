import { createHmac, timingSafeEqual } from "node:crypto";
import { CliError, ERROR_CODE, throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { shouldOutputJson } from "./shared.ts";

export interface WebhooksVerifyOptions {
  secret?: string;
  delivery?: string;
  payload?: string;
  id?: string;
  timestamp?: string;
  signature?: string;
  // Group-level flags are accepted but ignored: verify is pure offline HMAC.
  app?: string;
  instance?: string;
  json?: boolean;
}

const SECRET_PREFIX = "whsec_";
const SKEW_HINT_THRESHOLD_SECONDS = 5 * 60;

/** Decode the base64 key material after the `whsec_` prefix. Null when malformed. */
export function decodeWebhookSecret(secret: string): Buffer | null {
  if (!secret.startsWith(SECRET_PREFIX)) return null;
  const encoded = secret.slice(SECRET_PREFIX.length);
  if (!encoded) return null;
  const key = Buffer.from(encoded, "base64");
  if (key.length === 0) return null;
  // Buffer.from silently strips non-base64 chars and truncates unpadded input,
  // so a garbled secret would decode to wrong key material. Round-trip to reject
  // anything that isn't clean base64 (ignoring `=` padding differences).
  const stripPad = (s: string) => s.replace(/=+$/, "");
  if (stripPad(key.toString("base64")) !== stripPad(encoded)) return null;
  return key;
}

/**
 * Verify a Svix signature: HMAC-SHA256 over `{id}.{timestamp}.{payload}` with
 * the decoded secret, compared constant-time against every space-separated
 * `v1,<base64>` entry in the header (any match wins). During the 24h rotation
 * grace window the header carries multiple entries — that's why any-match matters.
 */
export function verifyWebhookSignature(input: {
  secret: string;
  id: string;
  timestamp: string;
  payload: string;
  signature: string;
}): boolean {
  const key = decodeWebhookSecret(input.secret);
  if (!key) return false;

  const expected = createHmac("sha256", key)
    .update(`${input.id}.${input.timestamp}.${input.payload}`, "utf8")
    .digest();

  return input.signature
    .split(/\s+/)
    .filter(Boolean)
    .some((entry) => {
      const commaIndex = entry.indexOf(",");
      if (commaIndex === -1) return false;
      const version = entry.slice(0, commaIndex);
      if (version !== "v1") return false;
      const candidate = Buffer.from(entry.slice(commaIndex + 1), "base64");
      return candidate.length === expected.length && timingSafeEqual(candidate, expected);
    });
}

export interface DeliveryFields {
  id?: string;
  timestamp?: string;
  signature?: string;
  payload?: string;
}

/**
 * Parse one `listen` event NDJSON line (`headers` + `body_b64`) into the four
 * verification inputs. Explicit flags override these at the call site.
 */
export function parseDeliveryLine(raw: string): DeliveryFields {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throwUsageError("--delivery is not valid JSON. Expected one `listen` event NDJSON line.");
  }
  if (parsed === null || typeof parsed !== "object") {
    throwUsageError("--delivery must be a JSON object (one `listen` event NDJSON line).");
  }

  const record = parsed as { headers?: Record<string, string>; body_b64?: string };
  const headers = record.headers ?? {};
  const fields: DeliveryFields = {
    id: headers["svix-id"],
    timestamp: headers["svix-timestamp"],
    signature: headers["svix-signature"],
  };
  if (typeof record.body_b64 === "string") {
    fields.payload = Buffer.from(record.body_b64, "base64").toString("utf8");
  }
  return fields;
}

async function readFileOrStdin(value: string, flag: string): Promise<string> {
  if (value === "-") {
    return await Bun.stdin.text();
  }
  if (value.startsWith("@")) {
    const path = value.slice(1);
    // Read directly rather than pre-checking exists(): Bun's stat-based exists()
    // reports false for readable character devices like /dev/null.
    try {
      return await Bun.file(path).text();
    } catch (err) {
      const reason = err instanceof Error ? `: ${err.message}` : "";
      throw new CliError(`Could not read ${path}${reason}`, { code: ERROR_CODE.FILE_NOT_FOUND });
    }
  }
  return throwUsageError(
    `${flag} takes @file or - for stdin (inline values get mangled by shells).`,
  );
}

function humanizeSkew(deltaSeconds: number): string {
  const minutes = Math.round(Math.abs(deltaSeconds) / 60);
  const span = minutes >= 1 ? `${minutes} minute${minutes === 1 ? "" : "s"}` : "less than a minute";
  return deltaSeconds > 0 ? `${span} in the past` : `${span} in the future`;
}

export async function webhooksVerify(options: WebhooksVerifyOptions = {}): Promise<void> {
  if (!options.secret) {
    throwUsageError("Missing required --secret whsec_...");
  }
  if (!decodeWebhookSecret(options.secret)) {
    throwUsageError("Invalid --secret. Expected a whsec_-prefixed base64 signing secret.");
  }

  // Both read stdin, which can only be consumed once.
  if (options.delivery === "-" && options.payload === "-") {
    throwUsageError(
      "Cannot use --delivery - and --payload - together: both read stdin, which can only be consumed once. Use --delivery - alone (its body_b64 provides the payload).",
    );
  }

  let fields: DeliveryFields = {};
  if (options.delivery) {
    const raw = await readFileOrStdin(options.delivery, "--delivery");
    // Accept the full `listen --json` stream: skip the `ready` line (and any
    // other non-event JSON) and use the first event line. Non-NDJSON input
    // falls through to the first non-empty line so error paths still fire.
    const lines = raw.split("\n").filter((line) => line.trim());
    const firstLine =
      lines.find((line) => {
        try {
          const parsed = JSON.parse(line.trim()) as { type?: unknown };
          return parsed !== null && typeof parsed === "object" && parsed.type !== "ready";
        } catch {
          return true;
        }
      }) ?? lines[0];
    if (!firstLine) {
      throwUsageError("--delivery input is empty. Expected one `listen` event NDJSON line.");
    }
    fields = parseDeliveryLine(firstLine);
  }

  // Explicit flags override --delivery fields.
  const id = options.id ?? fields.id;
  const timestamp = options.timestamp ?? fields.timestamp;
  const signature = options.signature ?? fields.signature;
  const hasPayload = options.payload !== undefined || fields.payload !== undefined;

  const missing = [
    !id && "--id",
    !timestamp && "--timestamp",
    !signature && "--signature",
    !hasPayload && "--payload",
  ].filter(Boolean);
  if (missing.length > 0) {
    throwUsageError(
      `Missing ${missing.join(", ")}. Pass --delivery @event.json or all four explicit flags.`,
    );
  }

  if (!/^\d+$/.test(timestamp!)) {
    throwUsageError(
      `Invalid --timestamp "${timestamp}". Expected Unix epoch seconds (the raw svix-timestamp header value).`,
    );
  }

  // Nullish-coalesce, not truthiness: an explicit empty `--payload` must reach
  // readFileOrStdin (which rejects it as neither @file nor -) instead of
  // silently falling through to the --delivery body or an `undefined` HMAC.
  const payload =
    options.payload !== undefined
      ? await readFileOrStdin(options.payload, "--payload")
      : fields.payload;

  const valid = verifyWebhookSignature({
    secret: options.secret,
    id: id!,
    timestamp: timestamp!,
    payload: payload!,
    signature: signature!,
  });

  if (!valid) {
    let message = "Signature verification failed: no signature entry matched.";
    // Only hint at clock skew when at least one entry was a structurally
    // plausible v1 HMAC-SHA256 (32 bytes) — otherwise the failure is a malformed
    // signature, not a timestamp problem, and a skew note would mislead.
    const HMAC_SHA256_BYTES = 32;
    const hasStructuralCandidate = signature!
      .split(/\s+/)
      .filter(Boolean)
      .some((entry) => {
        const comma = entry.indexOf(",");
        if (comma === -1 || entry.slice(0, comma) !== "v1") return false;
        return Buffer.from(entry.slice(comma + 1), "base64").length === HMAC_SHA256_BYTES;
      });
    const deltaSeconds = Math.floor(Date.now() / 1000) - Number(timestamp);
    if (hasStructuralCandidate && Math.abs(deltaSeconds) > SKEW_HINT_THRESHOLD_SECONDS) {
      message += ` Note: the timestamp is ${humanizeSkew(deltaSeconds)} — make sure it is the raw svix-timestamp header from the same delivery as the signature.`;
    }
    // Trailing-newline footgun: `echo` adds one, but the HMAC is byte-exact.
    if (options.payload !== undefined && typeof payload === "string" && payload.endsWith("\n")) {
      message +=
        " Note: the --payload file ends with a trailing newline; the HMAC is byte-exact. Write the raw body with no trailing newline (use printf, not echo), or use --delivery from a captured listen event.";
    }
    throw new CliError(message, { code: ERROR_CODE.INVALID_WEBHOOK_SIGNATURE });
  }

  if (shouldOutputJson(options)) {
    log.data(JSON.stringify({ valid: true }));
  } else {
    log.success("Signature verified.");
  }
}
