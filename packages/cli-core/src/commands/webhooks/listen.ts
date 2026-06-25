import { getRelayEntry, setRelayEntry } from "../../lib/config.ts";
import { EXIT_CODE, errorMessage, throwUsageError } from "../../lib/errors.ts";
import { cliSigintHandler } from "../../lib/signals.ts";
import { dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { isAgent } from "../../mode.ts";
import {
  buildForwardHeaders,
  forwardDelivery,
  parseHeaderPairs,
  type ForwardOutcome,
} from "./forward.ts";
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

  // --forward-to is logically required (forwarding is the point of the command),
  // but it's declared as a plain option so the failure is OUR usage error (JSON
  // in agent mode) rather than Commander's plain-text required-option message.
  if (!options.forwardTo) throwUsageError("--forward-to <url> is required.");
  let forwardUrl: URL;
  try {
    forwardUrl = new URL(options.forwardTo);
  } catch {
    return throwUsageError(
      `Invalid --forward-to URL "${options.forwardTo}". Expected http:// or https:// (e.g. http://localhost:3000).`,
    );
  }
  if (forwardUrl.protocol !== "http:" && forwardUrl.protocol !== "https:") {
    throwUsageError(
      `--forward-to must use http:// or https://; got "${forwardUrl.protocol.replace(":", "")}://".`,
    );
  }

  if (options.token) assertRelayToken(options.token);

  // svix-* headers can't be overridden (delivery headers always win) — warn once
  // at startup instead of silently dropping them.
  for (const key of Object.keys(extraHeaders)) {
    if (key.toLowerCase().startsWith("svix-")) {
      log.warn(`--headers: "${key}" can't be overridden — delivery svix-* headers always win.`);
    }
  }

  // The relay tunnel needs no Clerk backend (no auth, no instance, no signing
  // secret). Persist the token under a reserved key so the inbox URL stays
  // stable across runs — register it once in your dashboard and keep using it.
  // `--token` pins an explicit token (shareable / memorable).
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

    let outcome: ForwardOutcome | null = null;
    if (options.forwardTo) {
      outcome = await forwardDelivery({
        forwardTo: options.forwardTo,
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
    } else {
      // No local handler: frame a synthetic 200 so Svix-side delivery telemetry
      // records a completed attempt instead of a hang.
      reply(encodeEventResponseFrame({ id: event.id, status: 200, headers: {}, bodyB64: "" }));
    }

    if (ndjson) {
      log.data(
        buildEventLine({
          svixId,
          eventType,
          headers: event.headers,
          bodyB64: event.bodyB64,
          forwardStatus: outcome ? outcome.status : null,
          latencyMs: outcome?.latencyMs ?? 0,
        }),
      );
      return;
    }

    if (outcome && options.forwardTo) {
      renderForwardResult(outcome, event.method, forwardPath(options.forwardTo));
      renderForwardDiagnostics(outcome, svixId);
    }
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

  await client.start();

  const readyInfo = {
    relayUrl: relayReceiveUrl(client.token),
    signingSecret: null,
    endpointId: null,
    eventsFilter: null,
    forwardTo: options.forwardTo ?? null,
  };
  if (ndjson) {
    log.data(buildReadyLine(readyInfo));
  } else {
    renderReadyBanner(readyInfo);
    // No --token: the token was generated/persisted for you, but isn't a
    // guaranteed-stable handle. Nudge toward pinning a fixed, shareable URL.
    if (!options.token) renderUnpinnedTokenHint(client.token);
  }
  resolveSetupGate();

  // listen never exits 0: it ends via SIGINT (130) or an unrecoverable error (1).
  await new Promise<never>(() => {});
}
