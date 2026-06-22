/**
 * Instance + FAPI host resolution for `clerk api --fapi`.
 *
 * FAPI is the public API that clerk-js consumes. Its host is per-instance and
 * derived from the instance's publishable key. The passthrough request itself
 * lives in `lib/fapi.ts` (`fapiRequest`) alongside the other FAPI helpers.
 */

import { resolveAppContext, resolveFetchedApplicationInstance } from "../../lib/config.ts";
import { CliError, ERROR_CODE, throwUsageError, withApiContext } from "../../lib/errors.ts";
import { decodePublishableKey } from "../../lib/fapi.ts";
import { fetchApplication, type ApplicationInstance } from "../../lib/plapi.ts";

interface ResolveOptions {
  app?: string;
  instance?: string;
}

async function resolveInstance(options: ResolveOptions): Promise<ApplicationInstance> {
  if (options.app) {
    const app = await withApiContext(fetchApplication(options.app), "Failed to resolve instance");
    const resolved = resolveFetchedApplicationInstance(options.app, app, options.instance);
    if (!resolved.found) {
      throw new CliError(`Instance ${resolved.instanceId} not found in application.`, {
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
        docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
      });
    }
    return resolved.instance;
  }

  let ctx: Awaited<ReturnType<typeof resolveAppContext>>;
  try {
    ctx = await resolveAppContext({ app: options.app, instance: options.instance });
  } catch (error) {
    if (error instanceof CliError && error.code === ERROR_CODE.NOT_LINKED) {
      throwUsageError(
        "No instance found. Link a project with `clerk link`, or pass --app <app_id>.",
        "https://clerk.com/docs/guides/development/managing-environments",
        ERROR_CODE.NOT_LINKED,
      );
    }
    throw error;
  }

  const app = await withApiContext(fetchApplication(ctx.appId), "Failed to resolve instance");
  const resolved = resolveFetchedApplicationInstance(ctx.appId, app, ctx.instanceId);
  if (!resolved.found) {
    throw new CliError(`Instance ${ctx.instanceId} not found in application.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
      docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
    });
  }
  return resolved.instance;
}

/** Resolve the instance's FAPI host from its publishable key. */
export async function resolveFapiHost(options: ResolveOptions): Promise<string> {
  const instance = await resolveInstance(options);
  return decodePublishableKey(instance.publishable_key).fapiHost;
}
