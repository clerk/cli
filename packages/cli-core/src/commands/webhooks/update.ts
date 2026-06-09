import { resolveAppContext } from "../../lib/config.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { updateWebhookEndpoint, type UpdateWebhookEndpointParams } from "../../lib/plapi.ts";
import {
  formatEndpointDetails,
  printJson,
  rejectEndpointNotFound,
  shouldOutputJson,
  splitCommaList,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksUpdateOptions extends WebhooksGlobalOptions {
  endpointId: string;
  url?: string;
  events?: string;
  description?: string;
  channels?: string;
  enable?: boolean;
  disable?: boolean;
}

export function buildUpdateParams(options: WebhooksUpdateOptions): UpdateWebhookEndpointParams {
  if (options.enable && options.disable) {
    throwUsageError("--enable and --disable are mutually exclusive.");
  }

  const params: UpdateWebhookEndpointParams = {};
  if (options.url !== undefined) params.url = options.url;
  if (options.description !== undefined) params.description = options.description;
  const filterTypes = splitCommaList(options.events);
  if (filterTypes !== undefined) params.filter_types = filterTypes;
  const channels = splitCommaList(options.channels);
  if (channels !== undefined) params.channels = channels;
  if (options.enable) params.disabled = false;
  if (options.disable) params.disabled = true;

  if (Object.keys(params).length === 0) {
    throwUsageError(
      "Nothing to update. Pass at least one of --url, --events, --description, --channels, --enable, or --disable.",
    );
  }
  return params;
}

export async function webhooksUpdate(options: WebhooksUpdateOptions): Promise<void> {
  const params = buildUpdateParams(options);
  const ctx = await resolveAppContext(options);

  const endpoint = await rejectEndpointNotFound(
    updateWebhookEndpoint(ctx.appId, ctx.instanceId, options.endpointId, params),
    options.endpointId,
  );

  if (shouldOutputJson(options)) {
    printJson(endpoint);
    return;
  }

  log.success(`Updated webhook endpoint \`${endpoint.id}\``);
  formatEndpointDetails(endpoint);
}
