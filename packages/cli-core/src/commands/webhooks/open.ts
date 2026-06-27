import { cyan, dim } from "../../lib/color.ts";
import { resolveAppContext } from "../../lib/config.ts";
import { CliError, PlapiError, withApiContext } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { openBrowser } from "../../lib/open.ts";
import { getWebhookPortalUrl } from "../../lib/plapi.ts";
import { printJson, shouldOutputJson, type WebhooksGlobalOptions } from "./shared.ts";

export type WebhooksOpenOptions = WebhooksGlobalOptions;

export async function webhooksOpen(options: WebhooksOpenOptions = {}): Promise<void> {
  const ctx = await resolveAppContext(options);
  const { url } = await withApiContext(
    getWebhookPortalUrl(ctx.appId, ctx.instanceId),
    "Failed to fetch the webhook portal URL",
  ).catch((error) => {
    if (error instanceof PlapiError && error.status === 400 && error.code === "svix_app_missing") {
      throw new CliError(
        "No webhooks configured yet. Run `clerk webhooks create` to set up your first endpoint.",
      );
    }
    throw error;
  });

  if (shouldOutputJson(options)) {
    printJson({ url });
    return;
  }

  log.info(`↗ Opening the webhook portal for \`${ctx.appLabel}\` (${ctx.instanceLabel})`);
  log.info(`  ${dim(url)}`);

  const result = await openBrowser(url);
  if (!result.ok) {
    log.warn(
      `Could not open your browser automatically. Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}`,
    );
  }
}
