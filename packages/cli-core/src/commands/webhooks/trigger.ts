import { resolveAppContext } from "../../lib/config.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
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
    const page = await listWebhookEventTypes(appId, instanceId, {
      limit: CATALOG_PAGE_LIMIT,
      iterator,
    });
    if (page.data.some((entry) => entry.name === eventType)) return;
    iterator = page.cursor.has_next_page ? (page.cursor.starting_after ?? undefined) : undefined;
  } while (iterator);

  throw new CliError(
    `Unknown event type "${eventType}". Run \`clerk webhooks event-types\` to list available types.`,
    { code: ERROR_CODE.UNKNOWN_EVENT_TYPE },
  );
}

export async function webhooksTrigger(options: WebhooksTriggerOptions): Promise<void> {
  const ctx = await resolveAppContext(options);
  const endpointId = await resolveEndpointOrRelay(options.endpoint, ctx.instanceId);

  // send_example returns 200 {} asynchronously — an invalid event type would
  // otherwise exit 0 and deliver nothing, the silent failure trigger exists to kill.
  await assertKnownEventType(ctx.appId, ctx.instanceId, options.eventType);

  await rejectEndpointNotFound(
    sendWebhookExample(ctx.appId, ctx.instanceId, endpointId, options.eventType),
    endpointId,
  );

  log.success(
    `Sent example \`${options.eventType}\` event to \`${endpointId}\` (delivery is async)`,
  );
}
