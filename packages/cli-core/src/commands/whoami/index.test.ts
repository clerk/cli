import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureLog, credentialStoreStubs, tokenExchangeStubs } from "../../test/lib/stubs.ts";
import { CliError } from "../../lib/errors.ts";

const mockGetToken = mock();
const mockFetchUserInfo = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

mock.module("../../lib/token-exchange.ts", () => ({
  ...tokenExchangeStubs,
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

const { whoami } = await import("./index.ts");

describe("whoami", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockGetToken.mockReset();
    mockFetchUserInfo.mockReset();
    consoleSpy?.mockRestore();
  });

  function runWhoami() {
    return captured.run(() => whoami());
  }

  test("prints email when authenticated", async () => {
    mockGetToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "alice@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runWhoami();

    expect(captured.out).toContain("alice@example.com");
  });

  test("throws CliError when no token exists", async () => {
    mockGetToken.mockResolvedValue(null);

    await expect(runWhoami()).rejects.toThrow(CliError);
    await expect(captured.run(() => whoami())).rejects.toThrow(/Not logged in/);
    expect(captured.out).toBe("");
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("throws CliError when token is invalid", async () => {
    mockGetToken.mockResolvedValue("expired-token");
    mockFetchUserInfo.mockRejectedValue(new Error("Unauthorized"));

    await expect(runWhoami()).rejects.toThrow(CliError);
    await expect(captured.run(() => whoami())).rejects.toThrow(/Session expired/);
    expect(captured.out).toBe("");
  });
});
