import { resolveAppContext } from "../../lib/config.ts";
import { getWebhookEndpoint } from "../../lib/plapi.ts";
import {
  formatEndpointDetails,
  printJson,
  rejectEndpointNotFound,
  shouldOutputJson,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksGetOptions extends WebhooksGlobalOptions {
  endpointId: string;
}

export async function webhooksGet(options: WebhooksGetOptions): Promise<void> {
  const ctx = await resolveAppContext(options);
  const endpoint = await rejectEndpointNotFound(
    getWebhookEndpoint(ctx.appId, ctx.instanceId, options.endpointId),
    options.endpointId,
  );

  if (shouldOutputJson(options)) {
    printJson(endpoint);
    return;
  }

  formatEndpointDetails(endpoint);
}
