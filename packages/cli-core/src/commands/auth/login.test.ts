import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";
import { credentialStoreStubs, configStubs } from "../../test/stubs.ts";

const mockGetToken = mock();
const mockStoreToken = mock();
const mockGetAuth = mock();
const mockSetAuth = mock();
const mockExchangeCodeForToken = mock();
const mockFetchUserInfo = mock();
const mockStartAuthServer = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: (...args: unknown[]) => mockGetToken(...args),
  storeToken: (...args: unknown[]) => mockStoreToken(...args),
}));

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  setAuth: (...args: unknown[]) => mockSetAuth(...args),
}));

mock.module("../../lib/token-exchange.ts", () => ({
  exchangeCodeForToken: (...args: unknown[]) => mockExchangeCodeForToken(...args),
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

mock.module("../../lib/constants.ts", () => ({
  getOAuthConfig: () => ({
    clientId: "test-client-id",
    scopes: "profile email",
    authorizeUrl: "https://test.example.com/oauth/authorize",
    tokenUrl: "https://test.example.com/oauth/token",
    userinfoUrl: "https://test.example.com/oauth/userinfo",
  }),
  CALLBACK_PATH: "/callback",
  AUTH_TIMEOUT_MS: 120000,
}));

mock.module("../../lib/pkce.ts", () => ({
  generateCodeVerifier: () => "test-code-verifier",
  generateCodeChallenge: async () => "test-code-challenge",
  generateState: () => "test-state-value",
}));

mock.module("../../lib/auth-server.ts", () => ({
  startAuthServer: (...args: unknown[]) => mockStartAuthServer(...args),
}));

const { login } = await import("./login.ts");

describe("login", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const origSpawn = Bun.spawn;

  afterEach(() => {
    mockGetToken.mockReset();
    mockStoreToken.mockReset();
    mockGetAuth.mockReset();
    mockSetAuth.mockReset();
    mockExchangeCodeForToken.mockReset();
    mockFetchUserInfo.mockReset();
    mockStartAuthServer.mockReset();
    consoleSpy?.mockRestore();
    try {
      (Bun as any).spawn = origSpawn;
    } catch {
      // Bun.spawn may not be writable
    }
  });

  function mockBunSpawn() {
    try {
      (Bun as any).spawn = mock(() => ({ exited: Promise.resolve(0) }));
    } catch {
      // Bun.spawn may not be writable on some runtimes
    }
  }

  test("returns early when already authenticated with valid token", async () => {
    mockGetToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "existing@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await login();

    expect(result).toEqual({ userId: "user_123", email: "existing@example.com" });
    expect(consoleSpy).toHaveBeenCalledWith("Logged in as existing@example.com");
    expect(mockStartAuthServer).not.toHaveBeenCalled();
  });

  test("performs fresh login when no token exists", async () => {
    mockGetToken.mockResolvedValue(null);
    mockBunSpawn();

    const mockServer = {
      port: 54321,
      waitForCallback: mock().mockResolvedValue({ code: "fresh-auth-code" }),
      stop: mock(),
    };
    mockStartAuthServer.mockReturnValue(mockServer);

    mockExchangeCodeForToken.mockResolvedValue({
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await login();

    expect(result).toEqual({ userId: "user_new", email: "new@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalledWith("test-state-value");
    expect(mockExchangeCodeForToken).toHaveBeenCalledWith({
      code: "fresh-auth-code",
      codeVerifier: "test-code-verifier",
      redirectUri: "http://127.0.0.1:54321/callback",
    });
    expect(mockStoreToken).toHaveBeenCalledWith("new-access-token");
    expect(mockSetAuth).toHaveBeenCalledWith({ userId: "user_new" });
    expect(consoleSpy).toHaveBeenCalledWith("Logged in as new@example.com");
  });

  test("re-authenticates when existing token is expired", async () => {
    mockGetToken.mockResolvedValue("expired-token");
    mockGetAuth.mockResolvedValue({ userId: "user_old" });
    mockFetchUserInfo
      .mockRejectedValueOnce(new Error("Token expired"))
      .mockResolvedValueOnce({ userId: "user_refreshed", email: "refreshed@example.com" });
    mockBunSpawn();

    const mockServer = {
      port: 54321,
      waitForCallback: mock().mockResolvedValue({ code: "refresh-code" }),
      stop: mock(),
    };
    mockStartAuthServer.mockReturnValue(mockServer);

    mockExchangeCodeForToken.mockResolvedValue({
      access_token: "refreshed-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await login();

    expect(result).toEqual({ userId: "user_refreshed", email: "refreshed@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalled();
    expect(mockStoreToken).toHaveBeenCalledWith("refreshed-token");
  });

  test("stops auth server and throws when callback fails", async () => {
    mockGetToken.mockResolvedValue(null);
    mockBunSpawn();

    const mockServer = {
      port: 54321,
      waitForCallback: mock().mockRejectedValue(
        new Error("Authentication timed out. Please try again."),
      ),
      stop: mock(),
    };
    mockStartAuthServer.mockReturnValue(mockServer);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await expect(login()).rejects.toThrow("Authentication timed out");
    expect(mockServer.stop).toHaveBeenCalled();
  });

  test("proceeds with login when token exists but no auth config", async () => {
    mockGetToken.mockResolvedValue("orphan-token");
    mockGetAuth.mockResolvedValue(undefined);
    mockBunSpawn();

    const mockServer = {
      port: 54321,
      waitForCallback: mock().mockResolvedValue({ code: "new-code" }),
      stop: mock(),
    };
    mockStartAuthServer.mockReturnValue(mockServer);

    mockExchangeCodeForToken.mockResolvedValue({
      access_token: "brand-new-token",
      token_type: "Bearer",
      expires_in: 3600,
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_brand_new",
      email: "brandnew@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await login();

    expect(result).toEqual({ userId: "user_brand_new", email: "brandnew@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalled();
  });
});
