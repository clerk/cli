/**
 * Decoding a Clerk publishable key, which names its instance's Frontend API
 * host. Kept apart from the Frontend API client (`lib/fapi.ts`, which
 * re-exports it) so code that only reads keys doesn't load the API clients.
 */

import { CliError, ERROR_CODE } from "./errors.ts";

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
