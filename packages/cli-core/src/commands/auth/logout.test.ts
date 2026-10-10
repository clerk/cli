import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { useCaptureLog, credentialStoreStubs, configStubs } from "../../test/lib/stubs.ts";

const mockRevokeAndDeleteToken = mock();
const mockClearAuth = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  revokeAndDeleteToken: (...args: unknown[]) => mockRevokeAndDeleteToken(...args),
}));

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  clearAuth: (...args: unknown[]) => mockClearAuth(...args),
}));

const { logout } = await import("./logout.ts");

describe("logout", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  afterEach(() => {
    mockRevokeAndDeleteToken.mockReset();
    mockClearAuth.mockReset();
    consoleSpy?.mockRestore();
  });

  function runLogout() {
    return logout();
  }

  test("revokes the session, deletes the token, and clears auth config", async () => {
    mockRevokeAndDeleteToken.mockResolvedValue("revoked");
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(mockRevokeAndDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  test("prints success message", async () => {
    mockRevokeAndDeleteToken.mockResolvedValue("revoked");
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(captured.err).toContain("Logged out successfully");
  });

  test("reports success when there was no session to revoke", async () => {
    mockRevokeAndDeleteToken.mockResolvedValue("nothing_to_revoke");
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(captured.err).toContain("Logged out successfully");
    expect(captured.err).not.toContain("could not be revoked");
  });

  test("warns instead of claiming success when revocation fails", async () => {
    mockRevokeAndDeleteToken.mockResolvedValue("failed");
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(captured.err).toContain("could not be revoked with Clerk");
    expect(captured.err).not.toContain("Logged out successfully");
  });

  test("still clears auth config when revocation fails", async () => {
    mockRevokeAndDeleteToken.mockResolvedValue("failed");
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  test("warns that a platform API key still authenticates", async () => {
    const previous = process.env.CLERK_PLATFORM_API_KEY;
    process.env.CLERK_PLATFORM_API_KEY = "sk_test_platform";
    mockRevokeAndDeleteToken.mockResolvedValue("revoked");
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    try {
      await runLogout();
    } finally {
      if (previous === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
      else process.env.CLERK_PLATFORM_API_KEY = previous;
    }

    expect(captured.err).toContain("CLERK_PLATFORM_API_KEY");
  });
});
