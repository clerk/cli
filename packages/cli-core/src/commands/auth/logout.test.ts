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
    mockRevokeAndDeleteToken.mockResolvedValue(undefined);
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(mockRevokeAndDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  test("prints success message", async () => {
    mockRevokeAndDeleteToken.mockResolvedValue(undefined);
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(captured.err).toContain("Logged out successfully");
  });
});
