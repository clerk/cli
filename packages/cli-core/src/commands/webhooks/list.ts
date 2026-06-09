import { cyan, dim } from "../../lib/color.ts";
import { resolveAppContext } from "../../lib/config.ts";
import { withApiContext } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { listWebhookEndpoints, type WebhookEndpoint } from "../../lib/plapi.ts";
import {
  DEFAULT_PAGE_LIMIT,
  printIteratorHint,
  printJson,
  shouldOutputJson,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksListOptions extends WebhooksGlobalOptions {
  limit?: number;
  iterator?: string;
}

const COLUMN_PADDING = 2;

function endpointStatus(endpoint: WebhookEndpoint): string {
  return endpoint.disabled ? "disabled" : "enabled";
}

function endpointEvents(endpoint: WebhookEndpoint): string {
  return endpoint.filter_types?.length ? endpoint.filter_types.join(",") : "all";
}

function formatEndpointsTable(endpoints: WebhookEndpoint[]): void {
  const idWidth = Math.max("ID".length, ...endpoints.map((e) => e.id.length)) + COLUMN_PADDING;
  const urlWidth = Math.max("URL".length, ...endpoints.map((e) => e.url.length)) + COLUMN_PADDING;
  const statusWidth =
    Math.max("STATUS".length, ...endpoints.map((e) => endpointStatus(e).length)) + COLUMN_PADDING;

  log.info(
    `${dim("ID".padEnd(idWidth))}${dim("URL".padEnd(urlWidth))}${dim("STATUS".padEnd(statusWidth))}${dim("EVENTS")}`,
  );
  for (const endpoint of endpoints) {
    log.info(
      `${cyan(endpoint.id.padEnd(idWidth))}${endpoint.url.padEnd(urlWidth)}${endpointStatus(endpoint).padEnd(statusWidth)}${endpointEvents(endpoint)}`,
    );
  }
}

export async function webhooksList(options: WebhooksListOptions = {}): Promise<void> {
  const ctx = await resolveAppContext(options);
  const response = await withApiContext(
    listWebhookEndpoints(ctx.appId, ctx.instanceId, {
      limit: options.limit ?? DEFAULT_PAGE_LIMIT,
      iterator: options.iterator,
    }),
    "Failed to list webhook endpoints",
  );

  if (shouldOutputJson(options)) {
    printJson(response);
    return;
  }

  if (response.data.length === 0) {
    log.warn("No webhook endpoints found.");
    return;
  }

  formatEndpointsTable(response.data);
  const count = response.data.length;
  log.info(`\n${count} endpoint${count === 1 ? "" : "s"} returned`);
  printIteratorHint(response.cursor);
}
