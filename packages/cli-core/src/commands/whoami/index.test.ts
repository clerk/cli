import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { useCaptureLog, credentialStoreStubs, tokenExchangeStubs } from "../../test/lib/stubs.ts";
import { CliError } from "../../lib/errors.ts";

const mockGetValidToken = mock();
const mockFetchUserInfo = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

mock.module("../../lib/token-exchange.ts", () => ({
  ...tokenExchangeStubs,
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

const { whoami } = await import("./index.ts");

describe("whoami", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  afterEach(() => {
    mockGetValidToken.mockReset();
    mockFetchUserInfo.mockReset();
    consoleSpy?.mockRestore();
  });

  function runWhoami() {
    return whoami();
  }

  test("prints email when authenticated", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "alice@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runWhoami();

    expect(captured.out).toContain("alice@example.com");
  });

  test("throws CliError when no token exists", async () => {
    mockGetValidToken.mockResolvedValue(null);

    await expect(runWhoami()).rejects.toThrow(CliError);
    await expect(whoami()).rejects.toThrow(/Not logged in/);
    expect(captured.out).toBe("");
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("throws CliError when token is invalid", async () => {
    mockGetValidToken.mockResolvedValue("expired-token");
    mockFetchUserInfo.mockRejectedValue(new Error("Unauthorized"));

    await expect(runWhoami()).rejects.toThrow(CliError);
    await expect(whoami()).rejects.toThrow(/Session expired/);
    expect(captured.out).toBe("");
  });
});
