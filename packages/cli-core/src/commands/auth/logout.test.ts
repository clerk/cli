import { test, expect, describe } from "bun:test";
import { logout } from "./logout.ts";
import { testRoot } from "../../test/lib/test-root.ts";

describe("logout", () => {
  test("deletes token and clears auth config", async () => {
    const deps = testRoot({
      credentialStore: { deleteToken: async () => {} },
      configStore: { clearAuth: async () => {} },
    });

    await logout(deps);

    expect(deps.credentialStore.deleteToken).toHaveBeenCalledTimes(1);
    expect(deps.configStore.clearAuth).toHaveBeenCalledTimes(1);
  });

  test("prints success message", async () => {
    const deps = testRoot({
      credentialStore: { deleteToken: async () => {} },
      configStore: { clearAuth: async () => {} },
    });

    await logout(deps);

    expect(deps.log.info).toHaveBeenCalledWith("Logged out successfully");
  });
});
