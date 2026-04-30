import { bold, cyan, dim } from "../../lib/color.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { openBrowser } from "../../lib/open.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { buildDashboardUrl } from "../open/index.ts";
import { resolveUsersInstanceContext } from "./interactive/instance-context.ts";

export type UsersOpenOptions = {
  userId?: string;
  print?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
};

export async function open(options: UsersOpenOptions = {}): Promise<void> {
  const ctx = await resolveUsersInstanceContext({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  if (!ctx.appId || !ctx.instanceId) {
    throwUsageError(
      "Cannot build a dashboard URL from --secret-key alone. Use --app <app-id> instead, or run `clerk link` to link this directory.",
    );
  }

  const userId = options.userId;
  if (!userId) {
    throw new Error("user picker not implemented yet");
  }

  const subpath = `users/${userId}`;
  const url = buildDashboardUrl(ctx.appId, ctx.instanceId, subpath);

  if (options.print) {
    log.data(url);
    return;
  }

  if (isAgent()) {
    log.data(
      JSON.stringify({
        url,
        appId: ctx.appId,
        appName: null,
        instanceId: ctx.instanceId,
        instanceLabel: "development",
        userId,
        opened: false,
      }),
    );
    return;
  }

  const appLabel = ctx.appId;
  const instanceLabel = "development";

  intro("clerk users open");
  log.info(`↗ Opening ${bold(appLabel)} (${instanceLabel}) → ${cyan(subpath)}`);
  log.info(`  ${dim(url)}`);

  const result = await openBrowser(url);
  if (!result.ok) {
    log.warn(
      `Could not open your browser automatically. Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}`,
    );
  }

  outro();
}
