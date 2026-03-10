/**
 * Authentication session lifecycle
 * Manage auth state across operations.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, mockState, clerk } from "./setup.ts";

useIntegrationTestHarness();

test.each([{ mode: "human" }, { mode: "agent" }])(
  "whoami -> logout -> whoami cycle ($mode mode)",
  async ({ mode }) => {
    // Not logged in
    mockState.storedToken = null;
    const { stdout: notLoggedIn } = await clerk("--mode", mode, "whoami");
    expect(notLoggedIn).toContain("Not logged in");

    // Set token and verify whoami shows email
    mockState.storedToken = "valid_token";
    const { stdout: loggedIn } = await clerk("--mode", mode, "whoami");
    expect(loggedIn).toContain("test@example.com");

    // Logout
    const { stdout: logoutOutput } = await clerk("--mode", mode, "auth", "logout");
    expect(logoutOutput).toContain("Logged out successfully");
    expect(mockState.storedToken).toBeNull();

    // Whoami again -> not logged in
    const { stdout: afterLogout } = await clerk("--mode", mode, "whoami");
    expect(afterLogout).toContain("Not logged in");
  },
);
