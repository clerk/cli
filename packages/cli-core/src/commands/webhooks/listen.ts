import { getRelayEntry, setRelayEntry } from "../../lib/config.ts";
import { EXIT_CODE, errorMessage, throwUsageError } from "../../lib/errors.ts";
import { cliSigintHandler } from "../../lib/signals.ts";
import { withSpinner } from "../../lib/spinner.ts";
import { dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import { buildForwardHeaders, forwardDelivery, parseHeaderPairs } from "./forward.ts";
import { RelayClient } from "./relay-client.ts";
import {
  decodeEventBody,
  encodeEventResponseFrame,
  generateRelayToken,
  relayReceiveUrl,
  type RelayEventFrame,
} from "./relay-protocol.ts";
import {
  buildEventLine,
  buildReadyLine,
  renderArrival,
  renderForwardDiagnostics,
  renderForwardResult,
  renderReadyBanner,
  renderUnpinnedTokenHint,
} from "./render.ts";
import type { WebhooksGlobalOptions } from "./shared.ts";

export interface WebhooksListenOptions extends WebhooksGlobalOptions {
  forwardTo?: string;
  headers?: string;
  token?: string;
}

// Reserved config key for the standalone relay token. V1 ships a single tunnel,
// so there is no per-instance keying — one persisted token keeps the URL stable.
const RELAY_KEY = "__relay_only__";

/** Relay tokens are `c_` + 10 base62 chars; the relay rejects other shapes. */
function assertRelayToken(token: string): void {
  if (!/^c_[0-9A-Za-z]{10}$/.test(token)) {
    throwUsageError(
      `Invalid --token "${token}". A relay token is \`c_\` followed by 10 base62 chars (e.g. c_AbCd123456).`,
    );
  }
}

// Validated manually (not Commander's .requiredOption) so a missing/invalid
// value is OUR usage error — JSON in agent mode, not Commander's plain text.
function assertForwardTo(forwardTo: string | undefined): string {
  if (!forwardTo) throwUsageError("--forward-to <url> is required.");
  let url: URL;
  try {
    url = new URL(forwardTo);
  } catch {
    return throwUsageError(
      `Invalid --forward-to URL "${forwardTo}". Expected http:// or https:// (e.g. http://localhost:3000).`,
    );
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throwUsageError(
      `--forward-to must use http:// or https://; got "${url.protocol.replace(":", "")}://".`,
    );
  }
  return forwardTo;
}

function extractEventType(body: string): string {
  try {
    const parsed = JSON.parse(body) as { type?: unknown };
    if (typeof parsed.type === "string" && parsed.type) return parsed.type;
  } catch {
    // Non-JSON bodies still render; the type is just unknown.
  }
  return "unknown";
}

function forwardPath(forwardTo: string): string {
  try {
    return new URL(forwardTo).pathname;
  } catch {
    return forwardTo;
  }
}

export async function webhooksListen(options: WebhooksListenOptions = {}): Promise<void> {
  const ndjson = Boolean(options.json) || isAgent();
  const extraHeaders = parseHeaderPairs(options.headers);
  const forwardTo = assertForwardTo(options.forwardTo);

  if (options.token) assertRelayToken(options.token);

  // svix-* headers can't be overridden (delivery headers always win) — warn once
  // at startup instead of silently dropping them.
  for (const key of Object.keys(extraHeaders)) {
    if (key.toLowerCase().startsWith("svix-")) {
      log.warn(`--headers: "${key}" can't be overridden — delivery svix-* headers always win.`);
    }
  }

  // Persist the token so the inbox URL stays stable across runs; --token pins
  // an explicit one. No Clerk backend is involved.
  const existing = await getRelayEntry(RELAY_KEY);
  const token = options.token ?? existing?.token ?? generateRelayToken();
  if (token !== existing?.token) await setRelayEntry(RELAY_KEY, { token });

  const inFlight = new Set<Promise<void>>();
  let tokenRotationTask: Promise<void> | undefined;
  let client: RelayClient | undefined;
  let shuttingDown = false;

  // Deliveries can arrive the moment the relay handshake completes, but the
  // ready banner/line must print first. Gate processing until setup is done;
  // the SIGINT path also resolves it so the drain can never hang.
  let resolveSetupGate!: () => void;
  const setupGate = new Promise<void>((resolve) => {
    resolveSetupGate = resolve;
  });

  // Own SIGINT handling, registered BEFORE the socket opens. The global handler
  // (cli.ts) is a cleanup-free exit(130) and would fire first, so remove it:
  // close the socket, drain in-flight forwards, then exit 130.
  process.removeListener("SIGINT", cliSigintHandler);
  process.on("SIGINT", () => {
    void (async () => {
      shuttingDown = true; // MUST precede resolveSetupGate so processDelivery short-circuits
      resolveSetupGate(); // gated deliveries must settle or the drain hangs
      client?.stop();
      await Promise.allSettled([...inFlight, ...(tokenRotationTask ? [tokenRotationTask] : [])]);
      process.exit(EXIT_CODE.SIGINT);
    })();
  });

  async function processDelivery(
    event: RelayEventFrame,
    reply: (frame: string) => void,
  ): Promise<void> {
    await setupGate;
    if (shuttingDown) return;

    const body = decodeEventBody(event);
    const svixId = event.headers["svix-id"] ?? event.id;
    const eventType = extractEventType(body);

    if (!ndjson) renderArrival(eventType, svixId);

    const outcome = await forwardDelivery({
      forwardTo,
      method: event.method,
      headers: buildForwardHeaders(event.headers, extraHeaders),
      body,
    });
    reply(
      encodeEventResponseFrame({
        id: event.id,
        status: outcome.status,
        headers: outcome.headers,
        bodyB64: outcome.bodyB64,
      }),
    );

    if (ndjson) {
      log.data(
        buildEventLine({
          svixId,
          eventType,
          headers: event.headers,
          bodyB64: event.bodyB64,
          forwardStatus: outcome.status,
          latencyMs: outcome.latencyMs,
        }),
      );
      return;
    }

    renderForwardResult(outcome, event.method, forwardPath(forwardTo));
    renderForwardDiagnostics(outcome, svixId);
  }

  client = new RelayClient({
    token,
    onEvent: (event, reply) => {
      const task = processDelivery(event, reply).catch((error) => {
        log.debug(`relay: delivery handling failed: ${errorMessage(error)}`);
      });
      inFlight.add(task);
      void task.finally(() => inFlight.delete(task));
    },
    onTokenRotated: (newToken) => {
      // Persist the new token so the next run reuses it. There's no registered
      // endpoint to re-point (a dashboard endpoint needs a manual URL update
      // after a collision, which is rare).
      tokenRotationTask = setRelayEntry(RELAY_KEY, { token: newToken });
      return tokenRotationTask;
    },
    onReconnect: () => {
      if (ndjson) {
        log.data(JSON.stringify({ type: "reconnecting" }));
      } else {
        log.ui(dim("relay connection lost — reconnecting…\n"));
      }
    },
  });

  // Spinner is a no-op in agent/--json mode (isHuman() guard in lib/spinner.ts),
  // so NDJSON stdout stays clean; on a failed handshake it stops with "Failed".
  await withSpinner("Connecting to the webhook relay…", () => client.start());

  const readyInfo = { relayUrl: relayReceiveUrl(client.token), forwardTo };
  if (ndjson) {
    log.data(buildReadyLine(readyInfo));
  } else {
    renderReadyBanner(readyInfo);
    if (!options.token) renderUnpinnedTokenHint(client.token);
  }
  resolveSetupGate();

  // listen never exits 0: it ends via SIGINT (130) or an unrecoverable error (1).
  await new Promise<never>(() => {});
}
