import { getRelayEntry, resolveAppContext, setRelayEntry } from "../../lib/config.ts";
import { EXIT_CODE, PlapiError, errorMessage } from "../../lib/errors.ts";
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
}

interface ListenContext {
  appId: string;
  instanceId: string;
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
      let endpoint = await getWebhookEndpoint(ctx.appId, ctx.instanceId, entry.endpoint_id);
      const patch: UpdateWebhookEndpointParams = {};
      if (endpoint.url !== relayUrl) patch.url = relayUrl;
      if (eventsFilter && !sameFilter(endpoint.filter_types, eventsFilter)) {
        log.warn(
          "Updating the relay endpoint's event filter — this affects any other `listen` session sharing this instance's relay endpoint.",
        );
        patch.filter_types = eventsFilter;
      }
      if (Object.keys(patch).length > 0) {
        endpoint = await updateWebhookEndpoint(ctx.appId, ctx.instanceId, entry.endpoint_id, patch);
      }
      await setRelayEntry(ctx.instanceId, { token, endpoint_id: endpoint.id });
      return endpoint;
    } catch (error) {
      if (!(error instanceof PlapiError && error.status === 404)) throw error;
      // The persisted endpoint was deleted out from under us — recreate.
    }
  }

  const endpoint = await createWebhookEndpoint(ctx.appId, ctx.instanceId, {
    url: relayUrl,
    version: 1,
    ...(eventsFilter ? { filter_types: eventsFilter } : {}),
  });
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
  const ndjson = Boolean(options.json) || isAgent();
  const extraHeaders = parseHeaderPairs(options.headers);
  const rawFilter = splitCommaList(options.events);
  const eventsFilter = rawFilter?.length ? rawFilter : undefined;

  const ctx = await resolveAppContext(options);

  const entry = await getRelayEntry(ctx.instanceId);
  let token = entry?.token;
  if (!token) {
    token = generateRelayToken();
    await setRelayEntry(ctx.instanceId, { ...entry, token });
  }

  const inFlight = new Set<Promise<void>>();
  let client: RelayClient | undefined;
  let endpointSecret = "";

  // Own SIGINT handling, registered BEFORE the socket opens. The global
  // handler (cli.ts) is a cleanup-free exit(130) and would fire first, so it
  // has to go: close the socket, drain in-flight forwards, then exit 130.
  // The relay endpoint is never deleted — its URL and secret stay stable.
  process.removeAllListeners("SIGINT");
  process.on("SIGINT", () => {
    void (async () => {
      client?.stop();
      await Promise.allSettled(inFlight);
      process.exit(EXIT_CODE.SIGINT);
    })();
  });

  async function processDelivery(
    event: RelayEventFrame,
    reply: (frame: string) => void,
  ): Promise<void> {
    const body = decodeEventBody(event);
    const svixId = event.headers["svix-id"] ?? event.id;
    const eventType = extractEventType(body);

    if (!options.skipVerify) {
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

    if (outcome) {
      renderForwardResult(outcome, event.method, forwardPath(options.forwardTo!));
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
    onTokenRotated: async (newToken) => {
      const current = await getRelayEntry(ctx.instanceId);
      await setRelayEntry(ctx.instanceId, { ...current, token: newToken });
      // The registered endpoint must follow the new relay URL or deliveries
      // land in the old (now foreign) inbox.
      if (current?.endpoint_id) {
        try {
          await updateWebhookEndpoint(ctx.appId, ctx.instanceId, current.endpoint_id, {
            url: relayReceiveUrl(newToken),
          });
        } catch (error) {
          log.warn(
            `Could not re-point the relay endpoint after a token rotation: ${errorMessage(error)}`,
          );
        }
      }
    },
    onReconnect: () => {
      log.ui(dim("relay connection lost — reconnecting…\n"));
    },
  });

  await client.start();

  const endpoint = await ensureRelayEndpoint(ctx, client.token, eventsFilter);
  ({ secret: endpointSecret } = await getWebhookEndpointSecret(
    ctx.appId,
    ctx.instanceId,
    endpoint.id,
  ));

  const readyInfo = {
    relayUrl: relayReceiveUrl(client.token),
    signingSecret: endpointSecret,
    endpointId: endpoint.id,
    eventsFilter: eventsFilter ?? null,
    forwardTo: options.forwardTo ?? null,
  };
  if (ndjson) {
    log.data(buildReadyLine(readyInfo));
  } else {
    renderReadyBanner(readyInfo);
  }

  // listen never exits 0: it ends via SIGINT (130) or an unrecoverable error (1).
  await new Promise<never>(() => {});
}
