import { resolveAppContext } from "../../lib/config.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { listWebhookEventTypes, sendWebhookExample } from "../../lib/plapi.ts";
import {
  rejectEndpointNotFound,
  resolveEndpointOrRelay,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksTriggerOptions extends WebhooksGlobalOptions {
  eventType: string;
  endpoint?: string;
}

const CATALOG_PAGE_LIMIT = 250;

async function assertKnownEventType(
  appId: string,
  instanceId: string,
  eventType: string,
): Promise<void> {
  let iterator: string | undefined;
  do {
    const page = await withApiContext(
      listWebhookEventTypes(appId, instanceId, {
        limit: CATALOG_PAGE_LIMIT,
        iterator,
      }),
      "Failed to list webhook event types",
    );
    if (page.data.some((entry) => entry.name === eventType)) return;
    if (page.cursor.has_next_page && !page.cursor.starting_after) {
      throw new CliError(
        "Server returned has_next_page=true with no pagination cursor; cannot verify event type.",
      );
    }
    iterator = page.cursor.has_next_page ? (page.cursor.starting_after ?? undefined) : undefined;
  } while (iterator);

  throw new CliError(
    `Unknown event type "${eventType}". Run \`clerk webhooks event-types\` to list available types.`,
    { code: ERROR_CODE.UNKNOWN_EVENT_TYPE },
  );
}

export async function webhooksTrigger(options: WebhooksTriggerOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  // send_example returns 200 {} asynchronously — an invalid event type would
  // otherwise exit 0 and deliver nothing, the silent failure trigger exists to
  // kill. Validated first so agents get unknown_event_type even when no relay
  // endpoint is configured.
  await assertKnownEventType(ctx.appId, ctx.instanceId, options.eventType);

  const endpointId = await resolveEndpointOrRelay(options.endpoint, ctx.instanceId);

  await rejectEndpointNotFound(
    withApiContext(
      sendWebhookExample(ctx.appId, ctx.instanceId, endpointId, options.eventType),
      "Failed to send webhook example",
    ),
    endpointId,
  );

  log.success(
    `Sent example \`${options.eventType}\` event to \`${endpointId}\` (delivery is async)`,
  );
}
