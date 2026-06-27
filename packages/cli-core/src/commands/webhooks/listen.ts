import { getRelayEntry, resolveAppContext, setRelayEntry } from "../../lib/config.ts";
import {
  EXIT_CODE,
  PlapiError,
  errorMessage,
  throwUsageError,
  withApiContext,
} from "../../lib/errors.ts";
import { cliSigintHandler } from "../../lib/signals.ts";
import { dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import {
  createWebhookEndpoint,
  getWebhookEndpoint,
  getWebhookEndpointSecret,
  updateWebhookEndpoint,
  type UpdateWebhookEndpointParams,
  type WebhookEndpoint,
} from "../../lib/plapi.ts";
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
  renderVerificationWarning,
} from "./render.ts";
import { splitCommaList, type WebhooksGlobalOptions } from "./shared.ts";
import { verifyWebhookSignature } from "./verify.ts";

export interface WebhooksListenOptions extends WebhooksGlobalOptions {
  forwardTo?: string;
  events?: string;
  skipVerify?: boolean;
  headers?: string;
  relayOnly?: boolean;
  token?: string;
}

interface ListenContext {
  appId: string;
  instanceId: string;
}

// Reserved config key for the relay-only token. Real instance IDs are `ins_…`,
// so this never collides with a persisted per-instance relay entry.
const RELAY_ONLY_KEY = "__relay_only__";

/** Relay tokens are `c_` + 10 base62 chars; the relay rejects other shapes. */
function assertRelayToken(token: string): void {
  if (!/^c_[0-9A-Za-z]{10}$/.test(token)) {
    throwUsageError(
      `Invalid --token "${token}". A relay token is \`c_\` followed by 10 base62 chars (e.g. c_AbCd123456).`,
    );
  }
}

function sameFilter(current: string[] | null | undefined, next: string[]): boolean {
  const a = [...(current ?? [])].sort();
  const b = [...next].sort();
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

/**
 * Find-or-create is CLIENT-side: reuse the persisted endpoint ID, re-pointing
 * its URL if the token rotated and PATCHing `filter_types` when `--events`
 * differs. On 404 (or first run) create and persist. The backend does no
 * URL-uniqueness matching.
 */
async function ensureRelayEndpoint(
  ctx: ListenContext,
  token: string,
  eventsFilter: string[] | undefined,
): Promise<WebhookEndpoint> {
  const relayUrl = relayReceiveUrl(token);
  const entry = await getRelayEntry(ctx.instanceId);

  if (entry?.endpoint_id) {
    try {
      let endpoint = await withApiContext(
        getWebhookEndpoint(ctx.appId, ctx.instanceId, entry.endpoint_id),
        "Failed to get relay endpoint",
      );
      const patch: UpdateWebhookEndpointParams = {};
      if (endpoint.url !== relayUrl) patch.url = relayUrl;
      if (eventsFilter && !sameFilter(endpoint.filter_types, eventsFilter)) {
        log.warn(
          "Updating the relay endpoint's event filter — this affects any other `listen` session sharing this instance's relay endpoint.",
        );
        patch.filter_types = eventsFilter;
      } else if (!eventsFilter && (endpoint.filter_types?.length ?? 0) > 0) {
        patch.filter_types = [];
      }
      if (Object.keys(patch).length > 0) {
        endpoint = await withApiContext(
          updateWebhookEndpoint(ctx.appId, ctx.instanceId, entry.endpoint_id, patch),
          "Failed to update relay endpoint",
        );
      }
      await setRelayEntry(ctx.instanceId, { token, endpoint_id: endpoint.id });
      return endpoint;
    } catch (error) {
      if (
        !(
          error instanceof PlapiError &&
          (error.status === 404 || (error.status === 400 && error.code === "svix_app_missing"))
        )
      )
        throw error;
      // The persisted endpoint was deleted out from under us — recreate.
    }
  }

  const endpoint = await withApiContext(
    createWebhookEndpoint(ctx.appId, ctx.instanceId, {
      url: relayUrl,
      version: 1,
      ...(eventsFilter ? { filter_types: eventsFilter } : {}),
    }),
    "Failed to create relay endpoint",
  );
  await setRelayEntry(ctx.instanceId, { token, endpoint_id: endpoint.id });
  return endpoint;
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
  const relayOnly = Boolean(options.relayOnly);
  const ndjson = Boolean(options.json) || isAgent();
  const extraHeaders = parseHeaderPairs(options.headers);
  const rawFilter = splitCommaList(options.events);
  const eventsFilter = rawFilter?.length ? rawFilter : undefined;
  // relay-only has no signing secret (no backend), so it can't verify.
  const verifyDeliveries = !options.skipVerify && !relayOnly;

  if (options.token) {
    if (!relayOnly) throwUsageError("--token is only valid with --relay-only.");
    assertRelayToken(options.token);
  }

  // relay-only is a standalone Svix Play tunnel (no instance context, no PLAPI),
  // but it still persists its token under a reserved key so the relay URL stays
  // stable across runs — register it once in the dashboard and keep using it.
  // `--token` pins an explicit token (shareable / memorable). Every other mode
  // resolves the linked instance and reuses its persisted per-instance token.
  let ctx: ListenContext | undefined;
  let token: string;
  if (relayOnly) {
    const existing = await getRelayEntry(RELAY_ONLY_KEY);
    token = options.token ?? existing?.token ?? generateRelayToken();
    if (token !== existing?.token) await setRelayEntry(RELAY_ONLY_KEY, { token });
  } else {
    ctx = await resolveAppContext(options);
    const entry = await getRelayEntry(ctx.instanceId);
    token = entry?.token ?? generateRelayToken();
    if (!entry?.token) await setRelayEntry(ctx.instanceId, { ...entry, token });
  }

  const inFlight = new Set<Promise<void>>();
  let tokenRotationTask: Promise<void> | undefined;
  let client: RelayClient | undefined;
  let shuttingDown = false;

  // Deliveries can arrive as soon as the relay handshake completes (flow step
  // 2), but the signing secret only lands after the endpoint is resolved (step
  // 5) — verifying against the empty secret would warn falsely, so processing
  // waits on this gate, which resolves WITH the signing secret once the ready
  // line is out (the SIGINT path resolves it with "" to unblock the drain).
  let resolveSetupGate!: (secret: string) => void;
  const setupGate = new Promise<string>((resolve) => {
    resolveSetupGate = resolve;
  });

  // Own SIGINT handling, registered BEFORE the socket opens. The global
  // handler (cli.ts) is a cleanup-free exit(130) and would fire first, so it
  // has to go: close the socket, drain in-flight forwards, then exit 130.
  // The relay endpoint is never deleted — its URL and secret stay stable.
  process.removeListener("SIGINT", cliSigintHandler);
  process.on("SIGINT", () => {
    void (async () => {
      shuttingDown = true; // MUST precede resolveSetupGate so processDelivery short-circuits
      resolveSetupGate(""); // gated deliveries must settle or the drain hangs
      client?.stop();
      await Promise.allSettled([...inFlight, ...(tokenRotationTask ? [tokenRotationTask] : [])]);
      process.exit(EXIT_CODE.SIGINT);
    })();
  });

  async function processDelivery(
    event: RelayEventFrame,
    reply: (frame: string) => void,
  ): Promise<void> {
    const endpointSecret = await setupGate;
    if (shuttingDown) return;

    const body = decodeEventBody(event);
    const svixId = event.headers["svix-id"] ?? event.id;
    const eventType = extractEventType(body);

    if (verifyDeliveries) {
      const verified = verifyWebhookSignature({
        secret: endpointSecret,
        id: svixId,
        timestamp: event.headers["svix-timestamp"] ?? "",
        payload: body,
        signature: event.headers["svix-signature"] ?? "",
      });
      if (!verified) renderVerificationWarning(svixId);
    }

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
      // No local handler: frame a synthetic 200 so Svix-side delivery
      // telemetry records a completed attempt instead of a hang.
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
      // relay-only: persist the new token so the next run reuses it; there's no
      // registered endpoint to re-point (the dashboard endpoint needs a manual
      // URL update after a collision, which is rare).
      if (!ctx) {
        tokenRotationTask = setRelayEntry(RELAY_ONLY_KEY, { token: newToken });
        return tokenRotationTask;
      }
      const c = ctx;
      tokenRotationTask = (async () => {
        const current = await getRelayEntry(c.instanceId);
        await setRelayEntry(c.instanceId, { ...current, token: newToken });
        // The registered endpoint must follow the new relay URL or deliveries
        // land in the old (now foreign) inbox.
        if (current?.endpoint_id) {
          try {
            await updateWebhookEndpoint(c.appId, c.instanceId, current.endpoint_id, {
              url: relayReceiveUrl(newToken),
            });
          } catch (error) {
            log.warn(
              `Could not re-point the relay endpoint after a token rotation: ${errorMessage(error)} Webhook deliveries will be lost until you restart \`clerk webhooks listen\`.`,
            );
          }
        }
      })();
      return tokenRotationTask;
    },
    onReconnect: () => {
      log.ui(dim("relay connection lost — reconnecting…\n"));
    },
  });

  await client.start();

  let endpointId: string | null = null;
  let signingSecret: string | null = null;
  if (!relayOnly && ctx) {
    const endpoint = await ensureRelayEndpoint(ctx, client.token, eventsFilter);
    endpointId = endpoint.id;
    ({ secret: signingSecret } = await withApiContext(
      getWebhookEndpointSecret(ctx.appId, ctx.instanceId, endpoint.id),
      "Failed to get relay endpoint signing secret",
    ));
  }

  const readyInfo = {
    relayUrl: relayReceiveUrl(client.token),
    signingSecret,
    endpointId,
    eventsFilter: eventsFilter ?? null,
    forwardTo: options.forwardTo ?? null,
  };
  if (ndjson) {
    log.data(buildReadyLine(readyInfo));
  } else {
    renderReadyBanner(readyInfo);
  }
  resolveSetupGate(signingSecret ?? "");

  // listen never exits 0: it ends via SIGINT (130) or an unrecoverable error (1).
  await new Promise<never>(() => {});
}
