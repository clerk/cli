import { resolveAppContext } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";
import { deleteWebhookEndpoint } from "../../lib/plapi.ts";
import {
  confirmDestructive,
  rejectEndpointNotFound,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksDeleteOptions extends WebhooksGlobalOptions {
  endpointId: string;
  yes?: boolean;
}

export async function webhooksDelete(options: WebhooksDeleteOptions): Promise<void> {
  // Before resolveAppContext: the confirmation gate is pure flag/prompt logic
  // and must not cost (or be masked by) a network round-trip.
  await confirmDestructive(
    `Permanently delete webhook endpoint ${options.endpointId}? This cannot be undone.`,
    options,
  );

  const ctx = await resolveAppContext(options);

  await rejectEndpointNotFound(
    deleteWebhookEndpoint(ctx.appId, ctx.instanceId, options.endpointId),
    options.endpointId,
  );

  log.success(`Deleted webhook endpoint \`${options.endpointId}\``);
}
