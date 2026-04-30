import { resolveBapiSecretKey } from "../../lib/bapi-command.ts";
import { bold, cyan, dim } from "../../lib/color.ts";
import { CliError, ERROR_CODE, throwUsageError } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { openBrowser } from "../../lib/open.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { buildDashboardUrl } from "../open/index.ts";
import { resolveUsersInstanceContext } from "./interactive/instance-context.ts";
import { pickUser } from "./interactive/pick-user.ts";
import { registerUsersAction } from "./registry.ts";

export type UsersOpenOptions = {
  userId?: string;
  print?: boolean;
  secretKey?: string;
  app?: string;
  instance?: string;
};

export async function open(options: UsersOpenOptions = {}): Promise<void> {
  let target;
  try {
    target = await resolveUsersInstanceContext({
      app: options.app,
      instance: options.instance,
    });
  } catch (error) {
    if (options.secretKey && error instanceof CliError && error.code === ERROR_CODE.NOT_LINKED) {
      throwUsageError(
        "Cannot build a dashboard URL from --secret-key alone when no app target can be resolved. Use --app <app-id> instead, or run `clerk link` to link this directory.",
      );
    }
    throw error;
  }
  const secretKey = await resolveBapiSecretKey({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  let userId = options.userId;
  if (!userId) {
    if (isAgent()) {
      throwUsageError("User ID is required in agent mode. Pass it as a positional argument.");
    }
    userId = await pickUser({
      secretKey,
      message: "Pick a user to open in the dashboard:",
    });
  }

  if (!target.appId || !target.instanceId) {
    throwUsageError(
      "Cannot build a dashboard URL because no app target could be resolved. Use --app <app-id> instead, or run `clerk link` to link this directory.",
    );
  }

  const subpath = `users/${userId}`;
  const url = buildDashboardUrl(target.appId, target.instanceId, subpath);

  if (options.print) {
    log.data(url);
    return;
  }

  if (isAgent()) {
    log.data(
      JSON.stringify({
        url,
        appId: target.appId,
        appName: target.appLabel ?? null,
        instanceId: target.instanceId,
        instanceLabel: target.instanceLabel ?? target.instanceId,
        userId,
        opened: false,
      }),
    );
    return;
  }

  const appLabel = target.appLabel ?? target.appId;
  const instanceLabel = target.instanceLabel ?? target.instanceId;

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

registerUsersAction({
  key: "open",
  label: "Open user in dashboard",
  description: "Open a user's profile page in the Clerk dashboard",
  handler: async (targeting) => {
    await open(targeting);
  },
});
