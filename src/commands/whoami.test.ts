import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";

const mockGetToken = mock();
const mockFetchUserInfo = mock();

mock.module("../lib/credential-store.ts", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

mock.module("../lib/token-exchange.ts", () => ({
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

const { whoami } = await import("./whoami.ts");

describe("whoami", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
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

    expect(consoleSpy).toHaveBeenCalledWith("alice@example.com");
  });

  test("prompts to login when no token exists", async () => {
    mockGetToken.mockResolvedValue(null);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await whoami();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Not logged in")
    );
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("prints session expired when token is invalid", async () => {
    mockGetToken.mockResolvedValue("expired-token");
    mockFetchUserInfo.mockRejectedValue(new Error("Unauthorized"));

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await whoami();

    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Session expired")
    );
  });
});
