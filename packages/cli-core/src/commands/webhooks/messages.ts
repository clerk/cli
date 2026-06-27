import { cyan, dim, green, red, yellow } from "../../lib/color.ts";
import { resolveAppContext } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";
import {
  listWebhookMessages,
  type WebhookMessage,
  type WebhookMessageStatus,
} from "../../lib/plapi.ts";
import {
  DEFAULT_PAGE_LIMIT,
  printIteratorHint,
  printJson,
  rejectEndpointNotFound,
  resolveEndpointOrRelay,
  shouldOutputJson,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksMessagesOptions extends WebhooksGlobalOptions {
  endpoint?: string;
  status?: WebhookMessageStatus;
  limit?: number;
  iterator?: string;
}

// Pad before coloring so ANSI codes don't skew the column width.
function paddedStatus(status: WebhookMessage["status"], width: number): string {
  const padded = status.padEnd(width);
  switch (status) {
    case "success":
      return green(padded);
    case "fail":
      return red(padded);
    default:
      return yellow(padded);
  }
}

function formatMessagesTable(messages: WebhookMessage[]): void {
  const idWidth = Math.max("ID".length, ...messages.map((m) => m.id.length)) + 2;
  const eventWidth = Math.max("EVENT TYPE".length, ...messages.map((m) => m.event_type.length)) + 2;
  const statusWidth = Math.max("STATUS".length, ...messages.map((m) => m.status.length)) + 2;

  log.info(
    `${dim("ID".padEnd(idWidth))}${dim("EVENT TYPE".padEnd(eventWidth))}${dim("STATUS".padEnd(statusWidth))}${dim("CREATED")}`,
  );
  for (const message of messages) {
    log.info(
      `${cyan(message.id.padEnd(idWidth))}${message.event_type.padEnd(eventWidth)}${paddedStatus(message.status, statusWidth)}${message.created_at}`,
    );
  }
}

export async function webhooksMessages(options: WebhooksMessagesOptions = {}): Promise<void> {
  const ctx = await resolveAppContext(options);
  const endpointId = await resolveEndpointOrRelay(options.endpoint, ctx.instanceId);

  const response = await rejectEndpointNotFound(
    listWebhookMessages(ctx.appId, ctx.instanceId, endpointId, {
      limit: options.limit ?? DEFAULT_PAGE_LIMIT,
      iterator: options.iterator,
      status: options.status,
    }),
    endpointId,
  );

  if (shouldOutputJson(options)) {
    printJson(response);
    return;
  }

  if (response.data.length === 0) {
    log.warn(`No deliveries found for \`${endpointId}\`.`);
    printIteratorHint(response.cursor);
    return;
  }

  formatMessagesTable(response.data);
  const count = response.data.length;
  log.info(`\n${count} deliver${count === 1 ? "y" : "ies"} returned for \`${endpointId}\``);
  printIteratorHint(response.cursor);
}
