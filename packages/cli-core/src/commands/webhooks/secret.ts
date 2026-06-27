import { resolveAppContext } from "../../lib/config.ts";
import { withApiContext } from "../../lib/errors.ts";
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
  // Before resolveAppContext: the confirmation gate is pure flag/prompt logic
  // and must not cost (or be masked by) a network round-trip.
  if (options.rotate) {
    await confirmDestructive(
      `Rotate the signing secret for ${options.endpointId}? The old key keeps verifying for 24h (dual-signing grace).`,
      options,
    );
  }

  const ctx = await resolveAppContext(options);

  if (options.rotate) {
    await rejectEndpointNotFound(
      withApiContext(
        rotateWebhookEndpointSecret(ctx.appId, ctx.instanceId, options.endpointId),
        "Failed to rotate webhook signing secret",
      ),
      options.endpointId,
    );
  }

  const { secret } = await rejectEndpointNotFound(
    withApiContext(
      getWebhookEndpointSecret(ctx.appId, ctx.instanceId, options.endpointId),
      "Failed to fetch webhook signing secret",
    ),
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
