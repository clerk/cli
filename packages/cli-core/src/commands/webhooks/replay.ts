import { resolveAppContext } from "../../lib/config.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { recoverWebhookMessages, resendWebhookMessage } from "../../lib/plapi.ts";
import {
  confirmDestructive,
  rejectEndpointNotFound,
  rejectMessageNotFound,
  resolveEndpointOrRelay,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksReplayOptions extends WebhooksGlobalOptions {
  msgId?: string;
  endpoint?: string;
  since?: string;
  until?: string;
  yes?: boolean;
}

function assertRfc3339(value: string, flag: string): void {
  if (Number.isNaN(Date.parse(value))) {
    throwUsageError(`Invalid ${flag} value "${value}". Must be an RFC 3339 timestamp.`);
  }
}

function validateReplayMode(options: WebhooksReplayOptions): "resend" | "recover" {
  if (options.msgId && options.since) {
    throwUsageError("Pass either a <msg_id> or --since, not both.");
  }
  if (!options.msgId && !options.since) {
    throwUsageError("Pass a <msg_id> to resend one delivery, or --since <ISO> to bulk-recover.");
  }
  if (options.until && !options.since) {
    throwUsageError("--until requires --since.");
  }
  if (options.since) {
    assertRfc3339(options.since, "--since");
    if (options.until) assertRfc3339(options.until, "--until");
    if (!options.endpoint) {
      throwUsageError("--endpoint is required with --since. Bulk recovery never guesses a target.");
    }
    return "recover";
  }
  return "resend";
}

export async function webhooksReplay(options: WebhooksReplayOptions = {}): Promise<void> {
  const mode = validateReplayMode(options);
  const ctx = await resolveAppContext(options);

  if (mode === "resend") {
    const endpointId = await resolveEndpointOrRelay(options.endpoint, ctx.instanceId);
    await rejectMessageNotFound(
      resendWebhookMessage(ctx.appId, ctx.instanceId, endpointId, options.msgId!),
      options.msgId!,
    );
    log.success(`Queued replay of \`${options.msgId}\` to \`${endpointId}\``);
    return;
  }

  const windowLabel = options.until
    ? `between ${options.since} and ${options.until}`
    : `since ${options.since}`;
  await confirmDestructive(
    `Bulk-recover deliveries to ${options.endpoint} ${windowLabel}? Every failed delivery in the window will be resent.`,
    options,
  );

  await rejectEndpointNotFound(
    recoverWebhookMessages(ctx.appId, ctx.instanceId, options.endpoint!, {
      since: options.since!,
      until: options.until,
    }),
    options.endpoint!,
  );
  log.success(`Queued recovery of deliveries to \`${options.endpoint}\` ${windowLabel}`);
}
