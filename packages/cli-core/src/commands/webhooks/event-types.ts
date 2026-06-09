import { cyan, dim, yellow } from "../../lib/color.ts";
import { resolveAppContext } from "../../lib/config.ts";
import { withApiContext } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { listWebhookEventTypes, type WebhookEventType } from "../../lib/plapi.ts";
import {
  DEFAULT_PAGE_LIMIT,
  printIteratorHint,
  printJson,
  shouldOutputJson,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksEventTypesOptions extends WebhooksGlobalOptions {
  limit?: number;
  iterator?: string;
}

function formatEventTypesTable(eventTypes: WebhookEventType[]): void {
  const nameWidth = Math.max("NAME".length, ...eventTypes.map((t) => t.name.length)) + 2;

  log.info(`${dim("NAME".padEnd(nameWidth))}${dim("DESCRIPTION")}`);
  for (const eventType of eventTypes) {
    const archived = eventType.archived ? ` ${yellow("(archived)")}` : "";
    log.info(`${cyan(eventType.name.padEnd(nameWidth))}${eventType.description ?? ""}${archived}`);
  }
}

export async function webhooksEventTypes(options: WebhooksEventTypesOptions = {}): Promise<void> {
  const ctx = await resolveAppContext(options);
  const response = await withApiContext(
    listWebhookEventTypes(ctx.appId, ctx.instanceId, {
      limit: options.limit ?? DEFAULT_PAGE_LIMIT,
      iterator: options.iterator,
    }),
    "Failed to list webhook event types",
  );

  if (shouldOutputJson(options)) {
    printJson(response);
    return;
  }

  if (response.data.length === 0) {
    log.warn("No event types found.");
    return;
  }

  formatEventTypesTable(response.data);
  const count = response.data.length;
  log.info(`\n${count} event type${count === 1 ? "" : "s"} returned`);
  printIteratorHint(response.cursor);
}
