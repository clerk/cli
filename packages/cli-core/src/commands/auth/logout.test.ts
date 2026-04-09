import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureLog, credentialStoreStubs, configStubs } from "../../test/lib/stubs.ts";

const mockDeleteToken = mock();
const mockClearAuth = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  deleteToken: (...args: unknown[]) => mockDeleteToken(...args),
}));

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  clearAuth: (...args: unknown[]) => mockClearAuth(...args),
}));

const { logout } = await import("./logout.ts");

describe("logout", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockDeleteToken.mockReset();
    mockClearAuth.mockReset();
    consoleSpy?.mockRestore();
  });

  function runLogout() {
    return captured.run(() => logout());
  }

  test("deletes token and clears auth config", async () => {
    mockDeleteToken.mockResolvedValue(undefined);
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  test("prints success message", async () => {
    mockDeleteToken.mockResolvedValue(undefined);
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogout();

    expect(captured.err).toContain("Logged out successfully");
  });
});
