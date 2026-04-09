/**
 * Authentication session lifecycle
 * Manage auth state across operations.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, mockState, clerk } from "./lib/harness.ts";

useIntegrationTestHarness();

test.each([{ mode: "human" }, { mode: "agent" }])(
  "whoami -> logout -> whoami cycle ($mode mode)",
  async ({ mode }) => {
    // Not logged in — exits non-zero, error on stderr
    mockState.storedToken = null;
    const notLoggedIn = await clerk.raw("--mode", mode, "whoami");
    expect(notLoggedIn.exitCode).not.toBe(0);
    expect(notLoggedIn.stderr).toContain("Not logged in");

    // Set token and verify whoami shows email
    mockState.storedToken = "valid_token";
    const { stdout: loggedIn } = await clerk("--mode", mode, "whoami");
    expect(loggedIn).toContain("test@example.com");

    // Logout
    const logoutResult = await clerk.raw("--mode", mode, "auth", "logout");
    expect(logoutResult.stderr).toContain("Logged out successfully");
    expect(mockState.storedToken).toBeNull();

    // Whoami again -> not logged in
    const afterLogout = await clerk.raw("--mode", mode, "whoami");
    expect(afterLogout.exitCode).not.toBe(0);
    expect(afterLogout.stderr).toContain("Not logged in");
  },
);
