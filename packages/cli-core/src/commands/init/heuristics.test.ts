import { test, expect, describe, afterEach, mock } from "bun:test";

const mockGetValidToken = mock();
const mockHasStoredCredentials = mock();
mock.module("../../lib/credential-store.js", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
  hasStoredCredentials: (...args: unknown[]) => mockHasStoredCredentials(...args),
}));

const mockFetchUserInfo = mock();
mock.module("../../lib/token-exchange.js", () => ({
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

const { getAuthenticatedEmail, isAuthenticated } = await import("./heuristics.ts");

describe("heuristics auth primitives", () => {
  const originalApiKey = process.env.CLERK_PLATFORM_API_KEY;

  afterEach(() => {
    mockGetValidToken.mockReset();
    mockHasStoredCredentials.mockReset();
    mockFetchUserInfo.mockReset();
    if (originalApiKey == null) delete process.env.CLERK_PLATFORM_API_KEY;
    else process.env.CLERK_PLATFORM_API_KEY = originalApiKey;
  });

  test("isAuthenticated returns true when CLERK_PLATFORM_API_KEY is set — no network call", async () => {
    process.env.CLERK_PLATFORM_API_KEY = "ak_test";

    expect(await isAuthenticated()).toBe(true);
    expect(mockGetValidToken).not.toHaveBeenCalled();
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("isAuthenticated is presence-only and delegates to hasStoredCredentials", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockHasStoredCredentials.mockResolvedValue(true);

    expect(await isAuthenticated()).toBe(true);
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("getAuthenticatedEmail returns null when no token is stored", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockGetValidToken.mockResolvedValue(null);

    expect(await getAuthenticatedEmail()).toBeNull();
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("getAuthenticatedEmail returns the email when userinfo succeeds", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockGetValidToken.mockResolvedValue("valid_token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_1", email: "x@y.z" });

    expect(await getAuthenticatedEmail()).toBe("x@y.z");
  });

  test("getAuthenticatedEmail swallows fetch errors and returns null (expired/revoked/network)", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockGetValidToken.mockResolvedValue("expired_token");
    mockFetchUserInfo.mockRejectedValue(new Error("401 Unauthorized"));

    expect(await getAuthenticatedEmail()).toBeNull();
  });
});
