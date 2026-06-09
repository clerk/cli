import { cyan, dim } from "../../lib/color.ts";
import { resolveAppContext } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";
import { getWebhookEndpoint, type WebhookEndpoint } from "../../lib/plapi.ts";
import {
  printJson,
  rejectEndpointNotFound,
  shouldOutputJson,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksGetOptions extends WebhooksGlobalOptions {
  endpointId: string;
}

export function formatEndpointDetails(endpoint: WebhookEndpoint): void {
  const rows: Array<[string, string]> = [
    ["ID", cyan(endpoint.id)],
    ["URL", endpoint.url],
    ["Status", endpoint.disabled ? "disabled" : "enabled"],
    ["Description", endpoint.description || dim("(none)")],
    ["Events", endpoint.filter_types?.length ? endpoint.filter_types.join(", ") : "all"],
    ["Channels", endpoint.channels?.length ? endpoint.channels.join(", ") : dim("(none)")],
    ["Created", endpoint.created_at],
    ["Updated", endpoint.updated_at],
  ];
  const labelWidth = Math.max(...rows.map(([label]) => label.length)) + 2;
  for (const [label, value] of rows) {
    log.info(`${dim(`${label}:`.padEnd(labelWidth + 1))}${value}`);
  }
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
