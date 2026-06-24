import { resolveAppContext } from "../../lib/config.ts";
import { AuthError, CliError, ERROR_CODE, throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import {
  createWebhookEndpoint,
  getWebhookEndpointSecret,
  type CreateWebhookEndpointParams,
} from "../../lib/plapi.ts";
import {
  formatEndpointDetails,
  printJson,
  shouldOutputJson,
  splitCommaList,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksCreateOptions extends WebhooksGlobalOptions {
  url?: string;
  events?: string;
  description?: string;
  channels?: string;
  disabled?: boolean;
}

function buildCreateParams(options: WebhooksCreateOptions): CreateWebhookEndpointParams {
  if (!options.url) {
    throwUsageError("Missing required --url <https://...>.");
  }

  const params: CreateWebhookEndpointParams = { url: options.url, version: 1 };
  if (options.description !== undefined) params.description = options.description;
  if (options.disabled) params.disabled = true;
  const filterTypes = splitCommaList(options.events);
  if (filterTypes?.length) params.filter_types = filterTypes;
  const channels = splitCommaList(options.channels);
  if (channels?.length) params.channels = channels;
  return params;
}

export async function webhooksCreate(options: WebhooksCreateOptions = {}): Promise<void> {
  const params = buildCreateParams(options);
  const ctx = await resolveAppContext(options);

  const endpoint = await createWebhookEndpoint(ctx.appId, ctx.instanceId, params);

  let secret: string;
  try {
    ({ secret } = await getWebhookEndpointSecret(ctx.appId, ctx.instanceId, endpoint.id));
  } catch (error) {
    // An auth failure on the second call is the real problem — let it surface
    // with its own reason and docs URL instead of being masked as a transient
    // secret-fetch hiccup.
    if (error instanceof AuthError) throw error;
    // Create is atomic; the secret fetch is a second call. Never leave a
    // silent orphan — surface the new ID and the exact recovery command.
    throw new CliError(
      `Endpoint created (id: ${endpoint.id}) but the signing secret could not be fetched. ` +
        `Run 'clerk webhooks secret ${endpoint.id}' to retrieve it.`,
      { code: ERROR_CODE.WEBHOOK_SECRET_FETCH_FAILED },
    );
  }

  if (shouldOutputJson(options)) {
    printJson({ ...endpoint, signing_secret: secret });
    return;
  }

  log.success(`Created webhook endpoint \`${endpoint.id}\``);
  formatEndpointDetails(endpoint);
  log.info(`Signing secret: ${secret}`);
}
