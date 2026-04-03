import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { captureLog, credentialStoreStubs, tokenExchangeStubs } from "../../test/lib/stubs.ts";

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

  test("prints email when authenticated", async () => {
    mockGetToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "alice@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await whoami();

    expect(captured.out).toContain("alice@example.com");
  });

  test("prompts to login when no token exists", async () => {
    mockGetToken.mockResolvedValue(null);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await whoami();

    expect(captured.out).toContain("Not logged in");
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("prints session expired when token is invalid", async () => {
    mockGetToken.mockResolvedValue("expired-token");
    mockFetchUserInfo.mockRejectedValue(new Error("Unauthorized"));

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await whoami();

    expect(captured.out).toContain("Session expired");
  });
});
