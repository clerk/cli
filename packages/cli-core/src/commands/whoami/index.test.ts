import { test, expect } from "bun:test";
import { whoami } from "./index.ts";
import { testRoot } from "../../test/lib/test-root.ts";

test("prints email when authenticated", async () => {
  const deps = testRoot({
    credentialStore: { getToken: async () => "valid-token" },
    tokenExchange: {
      fetchUserInfo: async () => ({ userId: "user_123", email: "alice@example.com" }),
    },
  });

  await whoami(deps);

  expect(deps.log.data).toHaveBeenCalledWith("alice@example.com");
});

test("throws CliError when no token exists", async () => {
  const deps = testRoot({
    credentialStore: { getToken: async () => null },
  });

  await expect(whoami(deps)).rejects.toThrow(/Not logged in/);
});

test("throws CliError when token is invalid", async () => {
  const deps = testRoot({
    credentialStore: { getToken: async () => "expired-token" },
    tokenExchange: {
      fetchUserInfo: async () => {
        throw new Error("Unauthorized");
      },
    },
  });

  await expect(whoami(deps)).rejects.toThrow(/Session expired/);
});
