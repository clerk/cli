/**
 * Frontend API (FAPI) passthrough for `clerk api --fapi`.
 *
 * FAPI is the public API that clerk-js consumes. Its host is per-instance and
 * derived from the instance's publishable key, and the endpoints exposed here
 * (e.g. `/v1/environment`) are public, so no auth header is sent.
 */

import { resolveAppContext, resolveFetchedApplicationInstance } from "../../lib/config.ts";
import { normalizeBapiPath } from "../../lib/bapi-command.ts";
import {
  CliError,
  ERROR_CODE,
  FapiError,
  throwUsageError,
  withApiContext,
} from "../../lib/errors.ts";
import { decodePublishableKey } from "../../lib/fapi.ts";
import { loggedFetch } from "../../lib/fetch.ts";
import { fetchApplication, type ApplicationInstance } from "../../lib/plapi.ts";
import type { BapiResponse } from "./bapi.ts";

/** clerk-js API version FAPI shapes its `/v1/environment` payload for. */
const CLERK_JS_API_VERSION = "5";

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
  const instance = app.instances.find((entry) => entry.instance_id === ctx.instanceId);
  if (!instance) {
    throw new CliError(`Instance ${ctx.instanceId} not found in application.`, {
      code: ERROR_CODE.INSTANCE_NOT_FOUND,
      docsUrl: "https://clerk.com/docs/guides/development/managing-environments",
    });
  }
  return instance;
}

/** Resolve the instance's FAPI host from its publishable key. */
export async function resolveFapiHost(options: ResolveOptions): Promise<string> {
  const instance = await resolveInstance(options);
  return decodePublishableKey(instance.publishable_key).fapiHost;
}

export async function fapiRequest(options: {
  method: string;
  path: string;
  fapiHost: string;
  body?: string;
}): Promise<BapiResponse> {
  const url = new URL(`https://${options.fapiHost}${normalizeBapiPath(options.path)}`);
  if (!url.searchParams.has("_clerk_js_version")) {
    url.searchParams.set("_clerk_js_version", CLERK_JS_API_VERSION);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body) headers["Content-Type"] = "application/json";

  const response = await loggedFetch(url, {
    tag: "fapi",
    method: options.method,
    headers,
    body: options.body,
  });

  if (!response.ok) {
    throw await FapiError.fromResponse(response);
  }

  const rawBody = await response.text();
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    body = rawBody;
  }

  return { status: response.status, headers: response.headers, body, rawBody };
}
