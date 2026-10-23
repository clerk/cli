import { bold, cyan, dim } from "../../lib/color.ts";
import { resolveAppContext, resolveInstanceId, resolveProfile } from "../../lib/config.ts";
import { CliError, ERROR_CODE, throwUsageError } from "../../lib/errors.ts";
import { resolveKeylessTarget } from "../../lib/keyless-target.ts";
import { keylessRefusal, readUnlinkedFolder, rerunOf } from "../../lib/unlinked-folder.ts";
import { keylessCopy } from "../../lib/copy.ts";
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

async function resolveKnownUserDashboardTarget(options: UsersOpenOptions): Promise<{
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
}> {
  if (options.app) {
    const resolved = await resolveProfile(process.cwd());
    if (resolved?.profile.appId === options.app) {
      const instance = resolveInstanceId(resolved.profile, options.instance);
      return {
        appId: options.app,
        appLabel: resolved.profile.appName || options.app,
        instanceId: instance.id,
        instanceLabel: instance.label,
      };
    }
  } else {
    try {
      return await resolveAppContext({ instance: options.instance });
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== ERROR_CODE.NOT_LINKED) {
        throw error;
      }
    }
  }

  const target = await resolveUsersInstanceContext({
    app: options.app,
    instance: options.instance,
  });

  if (!target.appId || !target.instanceId) {
    throw new CliError("Internal: dashboard target missing appId/instanceId after resolution.", {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }

  return {
    appId: target.appId,
    appLabel: target.appLabel ?? target.appId,
    instanceId: target.instanceId,
    instanceLabel: target.instanceLabel ?? target.instanceId,
  };
}

/**
 * Fails with the real reason when the folder runs on its own secret key: a
 * Dashboard link needs the application's ID, which the key doesn't give.
 */
async function assertNotKeyless(options: UsersOpenOptions, userId: string): Promise<void> {
  // An explicit destination means the user is not asking about keyless at all,
  // and the original error is the accurate one.
  if (options.app || options.instance) return;

  const keyless = await resolveKeylessTarget({ cwd: process.cwd() });
  if (keyless) {
    // The user ID was validated as `user_<letters and digits>`, so it's safe to
    // echo; `--secret-key` never is.
    const { subject, step, examples } = keylessRefusal(
      await readUnlinkedFolder(process.cwd()),
      keyless.source,
      rerunOf([`clerk users open ${userId}`, options.print && "--print"]),
    );
    throw new CliError(keylessCopy.userDashboardNeedsClaim(subject, userId, step), {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
      examples,
    });
  }
}

export async function open(options: UsersOpenOptions = {}): Promise<void> {
  let userId = options.userId;
  if (userId !== undefined && !/^user_[A-Za-z0-9]+$/.test(userId)) {
    throwUsageError(`Invalid user ID '${userId}'. Expected format: user_<id>.`);
  }

  if (userId) {
    let target:
      | {
          appId: string;
          appLabel: string;
          instanceId: string;
          instanceLabel: string;
        }
      | undefined;

    try {
      target = await resolveKnownUserDashboardTarget(options);
    } catch (error) {
      // The deep link is `/apps/{appId}/…`, and a folder running on its own
      // secret key gives no app ID; say so before the `--secret-key` branch.
      await assertNotKeyless(options, userId);

      if (!options.secretKey) {
        throw error;
      }

      const secretKeyTarget = await resolveUsersInstanceContext({
        secretKey: options.secretKey,
        app: options.app,
        instance: options.instance,
      });
      if (!secretKeyTarget.appId || !secretKeyTarget.instanceId) {
        throwUsageError(
          "Cannot build a dashboard URL from --secret-key alone when no app target can be resolved. Use --app <app-id> instead, or run `clerk link` to link this directory.",
        );
      }

      target = {
        appId: secretKeyTarget.appId,
        appLabel: secretKeyTarget.appLabel ?? secretKeyTarget.appId,
        instanceId: secretKeyTarget.instanceId,
        instanceLabel: secretKeyTarget.instanceLabel ?? secretKeyTarget.instanceId,
      };
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
          appName: target.appLabel,
          instanceId: target.instanceId,
          instanceLabel: target.instanceLabel,
          userId,
        }),
      );
      return;
    }

    intro("Opening user");
    log.info(`↗ Opening ${bold(target.appLabel)} (${target.instanceLabel}) → ${cyan(subpath)}`);
    log.info(`  ${dim(url)}`);

    const result = await openBrowser(url);
    if (!result.ok) {
      log.warn(
        `Could not open your browser automatically. Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}`,
      );
    }

    await outro();
    return;
  }

  if (isAgent()) {
    throwUsageError("User ID is required in agent mode. Pass it as a positional argument.");
  }

  const target = await resolveUsersInstanceContext({
    secretKey: options.secretKey,
    app: options.app,
    instance: options.instance,
  });

  if (!target.secretKey) {
    throw new CliError("Internal: users open target is missing a secret key for pickUser.", {
      code: ERROR_CODE.NO_SECRET_KEY,
    });
  }

  userId = await pickUser({
    secretKey: target.secretKey,
    message: "Pick a user to open in the dashboard:",
  });

  if (!target.appId || !target.instanceId) {
    if (options.secretKey) {
      throwUsageError(
        "Cannot build a dashboard URL from --secret-key alone when no app target can be resolved. Use --app <app-id> instead, or run `clerk link` to link this directory.",
      );
    }

    throw new CliError("Internal: dashboard target missing appId/instanceId after resolution.", {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }

  const subpath = `users/${userId}`;
  const url = buildDashboardUrl(target.appId, target.instanceId, subpath);

  if (options.print) {
    log.data(url);
    return;
  }

  const appLabel = target.appLabel ?? target.appId;
  const instanceLabel = target.instanceLabel ?? target.instanceId;

  intro("Opening user");
  log.info(`↗ Opening ${bold(appLabel)} (${instanceLabel}) → ${cyan(subpath)}`);
  log.info(`  ${dim(url)}`);

  const result = await openBrowser(url);
  if (!result.ok) {
    log.warn(
      `Could not open your browser automatically. Open this URL to continue:\n  ${cyan(url)}\n${dim(`(Reason: ${result.reason})`)}`,
    );
  }

  await outro();
}

registerUsersAction({
  key: "open",
  label: "Open user in dashboard",
  description: "Open a user's profile page in the Clerk dashboard",
  handler: async (targeting) => {
    await open(targeting);
  },
});
