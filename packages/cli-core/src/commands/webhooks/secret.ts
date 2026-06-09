import { resolveAppContext } from "../../lib/config.ts";
import { log } from "../../lib/log.ts";
import { getWebhookEndpointSecret, rotateWebhookEndpointSecret } from "../../lib/plapi.ts";
import {
  confirmDestructive,
  printJson,
  rejectEndpointNotFound,
  shouldOutputJson,
  type WebhooksGlobalOptions,
} from "./shared.ts";

export interface WebhooksSecretOptions extends WebhooksGlobalOptions {
  endpointId: string;
  rotate?: boolean;
  yes?: boolean;
}

export async function webhooksSecret(options: WebhooksSecretOptions): Promise<void> {
  const ctx = await resolveAppContext(options);

  if (options.rotate) {
    await confirmDestructive(
      `Rotate the signing secret for ${options.endpointId}? The old key keeps verifying for 24h (dual-signing grace).`,
      options,
    );
    await rejectEndpointNotFound(
      rotateWebhookEndpointSecret(ctx.appId, ctx.instanceId, options.endpointId),
      options.endpointId,
    );
  }

  const { secret } = await rejectEndpointNotFound(
    getWebhookEndpointSecret(ctx.appId, ctx.instanceId, options.endpointId),
    options.endpointId,
  );

  if (shouldOutputJson(options)) {
    printJson({ secret });
    return;
  }

  if (options.rotate) {
    log.success(
      `Signing secret rotated. The previous key remains valid for 24 hours while Svix dual-signs.`,
    );
  }
  log.info(`Signing secret for \`${options.endpointId}\`:`);
  // Bare secret on stdout so $(clerk webhooks secret ep_...) is eval-friendly.
  log.data(secret);
}
