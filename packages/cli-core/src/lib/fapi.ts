/**
 * Frontend API (FAPI) client.
 * Thin HTTP wrapper for Clerk's Frontend API endpoints used by the interactive
 * users wizard. Sibling to lib/plapi.ts.
 */

import type { UserSettingsJSON } from "@clerk/shared/types";
import { CliError, FapiError, ERROR_CODE } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";

const PK_TEST_PREFIX = "pk_test_";
const PK_LIVE_PREFIX = "pk_live_";

/**
 * The clerk-js client version FAPI's `/v1/environment` payload is shaped for.
 * Bump when consuming response fields introduced in a later major version.
 */
export const CLERK_JS_API_VERSION = "6";

export type InstanceType = "development" | "production";

export type DecodedPublishableKey = {
  fapiHost: string;
  instanceType: InstanceType;
};

export function decodePublishableKey(pk: string): DecodedPublishableKey {
  let instanceType: InstanceType;
  let encoded: string;

  if (pk.startsWith(PK_TEST_PREFIX)) {
    instanceType = "development";
    encoded = pk.slice(PK_TEST_PREFIX.length);
  } else if (pk.startsWith(PK_LIVE_PREFIX)) {
    instanceType = "production";
    encoded = pk.slice(PK_LIVE_PREFIX.length);
  } else {
    throw new CliError("Invalid publishable key format: missing pk_test_ or pk_live_ prefix.", {
      code: ERROR_CODE.INVALID_KEY_FORMAT,
    });
  }

  let decoded: string;
  try {
    decoded = atob(encoded);
  } catch {
    throw new CliError("Invalid publishable key format: not valid base64.", {
      code: ERROR_CODE.INVALID_KEY_FORMAT,
    });
  }

  if (!decoded.endsWith("$")) {
    throw new CliError("Invalid publishable key format: decoded host missing $ terminator.", {
      code: ERROR_CODE.INVALID_KEY_FORMAT,
    });
  }

  const host = decoded.slice(0, -1);

  if (!/^[a-zA-Z0-9.-]+$/.test(host)) {
    throw new CliError(
      "Invalid publishable key format: decoded host contains invalid characters.",
      { code: ERROR_CODE.INVALID_KEY_FORMAT },
    );
  }

  return {
    fapiHost: host,
    instanceType,
  };
}

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
