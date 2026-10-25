import { afterEach, beforeEach, expect, test } from "bun:test";
import type { AutoclaimResult } from "../../lib/autoclaim.ts";
import { PlapiError } from "../../lib/errors.ts";
import { claimWarning } from "./claim-report.ts";

let savedKey: string | undefined;
beforeEach(() => {
  savedKey = process.env.CLERK_PLATFORM_API_KEY;
  delete process.env.CLERK_PLATFORM_API_KEY;
});
afterEach(() => {
  if (savedKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = savedKey;
});

const refused = (status: number): AutoclaimResult => ({
  status: "failed",
  error: new PlapiError(
    status,
    JSON.stringify({ errors: [{ code: "refused", message: "Refused" }] }),
  ),
});

// `CLERK_PLATFORM_API_KEY` wins over any session (`lib/plapi.ts`), so with it
// set, signing in with another account can't change who claims.
test.each([
  {
    claim: "403, a session",
    status: 403,
    apiKey: undefined,
    says: "Unable to claim - this account can't claim the app: Refused. The claim token stays in this folder, so signing in with another account tries again.",
  },
  {
    claim: "403, CLERK_PLATFORM_API_KEY",
    status: 403,
    apiKey: "ak_test_key",
    says: "Unable to claim - this account can't claim the app: Refused. The claim token stays in this folder.",
  },
  {
    claim: "401, a session",
    status: 401,
    apiKey: undefined,
    says: "Unable to claim - Clerk refused this credential: Refused. The claim token stays in this folder, so the next `clerk auth login` tries again.",
  },
])("claimWarning, $claim", ({ status, apiKey, says }) => {
  if (apiKey) process.env.CLERK_PLATFORM_API_KEY = apiKey;

  expect(claimWarning(refused(status))).toBe(says);
});
