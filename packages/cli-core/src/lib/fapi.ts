/**
 * Frontend API (FAPI) client.
 * Thin HTTP wrapper for Clerk's Frontend API endpoints used by the interactive
 * users wizard. Sibling to lib/plapi.ts.
 */

import type { UserSettingsJSON } from "@clerk/shared/types";
import { normalizeBapiPath } from "./bapi-command.ts";
import { CliError, FapiError, ERROR_CODE } from "./errors.ts";
import { loggedFetch, type ApiResponse } from "./fetch.ts";

/**
 * The clerk-js client version FAPI's `/v1/environment` payload is shaped for.
 * Bump when consuming response fields introduced in a later major version.
 */
export const CLERK_JS_API_VERSION = "6";

export {
  decodePublishableKey,
  type DecodedPublishableKey,
  type InstanceType,
} from "./publishable-key.ts";

export type { UserSettingsJSON };

async function fapiFetch(method: "GET" | "POST", url: URL): Promise<Response> {
  const response = await loggedFetch(url, { tag: "fapi", method });
  if (!response.ok) {
    throw await FapiError.fromResponse(response);
  }
  return response;
}

async function fapiFetchJson<T>(method: "GET" | "POST", url: URL): Promise<T> {
  const response = await fapiFetch(method, url);
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new CliError(`FAPI returned non-JSON response from ${url.pathname}.`, {
      code: ERROR_CODE.FAPI_ERROR,
    });
  }
}

export async function bootstrapDevBrowser(fapiHost: string): Promise<string> {
  const url = new URL(`https://${fapiHost}/v1/dev_browser`);
  const body = await fapiFetchJson<{ token?: unknown }>("POST", url);
  if (typeof body.token !== "string" || body.token.length === 0) {
    throw new CliError("Dev browser response did not include a token.", {
      code: ERROR_CODE.FAPI_ERROR,
    });
  }
  return body.token;
}

export async function fetchUserSettings(
  fapiHost: string,
  opts: { jwt?: string },
): Promise<UserSettingsJSON> {
  const url = new URL(`https://${fapiHost}/v1/environment`);
  url.searchParams.set("_clerk_js_version", CLERK_JS_API_VERSION);
  if (opts.jwt) {
    url.searchParams.set("__clerk_db_jwt", opts.jwt);
  }
  const body = await fapiFetchJson<{ user_settings?: UserSettingsJSON }>("GET", url);
  if (!body.user_settings) {
    throw new CliError("FAPI environment response did not include user_settings.", {
      code: ERROR_CODE.FAPI_ERROR,
    });
  }
  return body.user_settings;
}

/**
 * Passthrough request used by `clerk api --fapi`. Unlike the typed helpers
 * above, this issues an arbitrary request against the instance's FAPI host and
 * returns the normalized response untouched. FAPI endpoints exposed here are
 * public, so no auth header is sent.
 */
export async function fapiRequest(options: {
  method: string;
  path: string;
  fapiHost: string;
  body?: string;
}): Promise<ApiResponse> {
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
