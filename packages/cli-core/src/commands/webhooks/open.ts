import { cyan, dim } from "../../lib/color.ts";
import { resolveAppContext } from "../../lib/config.ts";
import { withApiContext } from "../../lib/errors.ts";
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
  );

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
