import { fetchAppsTolerantly, pickOrCreateApp } from "../../../lib/app-picker.ts";
import { resolveAppContext, resolveFetchedApplicationInstance } from "../../../lib/config.ts";
import { CliError, ERROR_CODE, withApiContext } from "../../../lib/errors.ts";
import { decodePublishableKey } from "../../../lib/fapi.ts";
import { fetchApplication, validateKeyPrefix } from "../../../lib/plapi.ts";
import { isHuman } from "../../../mode.ts";

export type UsersInstanceContext = {
  secretKey: string;
  publishableKey?: string;
  fapiHost?: string;
};

export type ResolveUsersInstanceContextOptions = {
  app?: string;
  instance?: string;
  secretKey?: string;
};

export async function resolveUsersInstanceContext(
  options: ResolveUsersInstanceContextOptions,
): Promise<UsersInstanceContext> {
  if (options.secretKey && !options.app) {
    validateKeyPrefix(options.secretKey, "sk_");
    return { secretKey: options.secretKey };
  }

  let appId: string | undefined = options.app;
  let instanceHint: string | undefined = options.instance;

  if (!appId) {
    try {
      const ctx = await resolveAppContext({ instance: options.instance });
      appId = ctx.appId;
      instanceHint = ctx.instanceId;
    } catch (error) {
      if (!(error instanceof CliError) || error.code !== ERROR_CODE.NOT_LINKED) {
        throw error;
      }
      if (options.secretKey) {
        validateKeyPrefix(options.secretKey, "sk_");
        return { secretKey: options.secretKey };
      }
      if (isHuman()) {
        const apps = await fetchAppsTolerantly();
        const picked = await pickOrCreateApp({
          apps,
          message: "Select a Clerk application to use:",
        });
        appId = picked.application_id;
      } else {
        throw error;
      }
    }
  }

  const app = await withApiContext(fetchApplication(appId), "Failed to resolve instance context");
  const resolved = resolveFetchedApplicationInstance(appId, app, instanceHint);
  if (!resolved.found) {
    throw new CliError(`Instance ${resolved.instanceId} not found in application.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
    });
  }
  const instance = resolved.instance;
  if (!instance.secret_key) {
    throw new CliError(`No secret key found for ${resolved.instanceLabel} instance.`, {
      code: ERROR_CODE.NO_SECRET_KEY,
    });
  }

  const ctx: UsersInstanceContext = { secretKey: options.secretKey ?? instance.secret_key };
  if (instance.publishable_key) {
    ctx.publishableKey = instance.publishable_key;
    try {
      ctx.fapiHost = decodePublishableKey(instance.publishable_key).fapiHost;
    } catch {
      // Leave fapiHost undefined if the publishable key is malformed.
    }
  }
  return ctx;
}
