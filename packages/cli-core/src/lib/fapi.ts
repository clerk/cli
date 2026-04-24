/**
 * Frontend API (FAPI) client.
 * Thin HTTP wrapper for Clerk's Frontend API endpoints used by the interactive
 * users wizard. Sibling to lib/plapi.ts.
 */

import type { UserSettingsJSON } from "@clerk/shared/types";
import { CliError, ERROR_CODE } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";

const PK_TEST_PREFIX = "pk_test_";
const PK_LIVE_PREFIX = "pk_live_";

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

  return {
    fapiHost: decoded.slice(0, -1),
    instanceType,
  };
}

export type { UserSettingsJSON };

export async function bootstrapDevBrowser(fapiHost: string): Promise<string> {
  const url = new URL(`https://${fapiHost}/v1/dev_browser`);
  const response = await loggedFetch(url, { tag: "fapi", method: "POST" });
  if (!response.ok) {
    throw new CliError(
      `Failed to bootstrap dev browser: ${response.status} ${response.statusText}`,
      {
        code: ERROR_CODE.FAPI_ERROR,
      },
    );
  }
  const body = (await response.json()) as { token?: unknown };
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
  url.searchParams.set("_clerk_js_version", "5");
  if (opts.jwt) {
    url.searchParams.set("__clerk_db_jwt", opts.jwt);
  }
  const response = await loggedFetch(url, { tag: "fapi", method: "GET" });
  if (!response.ok) {
    throw new CliError(
      `Failed to fetch instance settings: ${response.status} ${response.statusText}`,
      { code: ERROR_CODE.FAPI_ERROR },
    );
  }
  const body = (await response.json()) as { user_settings?: UserSettingsJSON };
  if (!body.user_settings) {
    throw new CliError("FAPI environment response did not include user_settings.", {
      code: ERROR_CODE.FAPI_ERROR,
    });
  }
  return body.user_settings;
}
