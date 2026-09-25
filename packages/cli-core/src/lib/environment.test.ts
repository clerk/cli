import { test, expect, describe } from "bun:test";
import { DEFAULT_PROFILES } from "./environment.ts";

describe("DEFAULT_PROFILES", () => {
  // Local builds without CLI_ENV_PROFILES fall back to these values, so they
  // must match the production profile release builds inject. A wrong client ID
  // makes `clerk auth login` fail with `invalid_client`.
  test("production matches the released production profile", () => {
    expect(DEFAULT_PROFILES.production).toMatchObject({
      oauthClientId: "x7Fzlnxuu5I6UUa4",
      oauthBaseUrl: "https://clerk.clerk.com",
      platformApiUrl: "https://api.clerk.com",
      backendApiUrl: "https://api.clerk.com",
    });
  });

  test("production OAuth client ID is not a Clerk resource ID", () => {
    // Resource IDs like `ins_...` are not OAuth client IDs.
    expect(DEFAULT_PROFILES.production!.oauthClientId).not.toMatch(/^[a-z]+_/);
  });
});
