import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { credentialStoreStubs, configStubs } from "../../test/stubs.ts";

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

  afterEach(() => {
    mockDeleteToken.mockReset();
    mockClearAuth.mockReset();
    consoleSpy?.mockRestore();
  });

  test("deletes token and clears auth config", async () => {
    mockDeleteToken.mockResolvedValue(undefined);
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await logout();

    expect(mockDeleteToken).toHaveBeenCalledTimes(1);
    expect(mockClearAuth).toHaveBeenCalledTimes(1);
  });

  test("prints success message", async () => {
    mockDeleteToken.mockResolvedValue(undefined);
    mockClearAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await logout();

    expect(consoleSpy).toHaveBeenCalledWith("Logged out successfully.");
  });
});
