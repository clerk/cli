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
  const ctx = await resolveAppContext(options);

  await confirmDestructive(
    `Permanently delete webhook endpoint ${options.endpointId}? This cannot be undone.`,
    options,
  );

  await rejectEndpointNotFound(
    deleteWebhookEndpoint(ctx.appId, ctx.instanceId, options.endpointId),
    options.endpointId,
  );

  log.success(`Deleted webhook endpoint \`${options.endpointId}\``);
}
