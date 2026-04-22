import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { AuthError } from "../../lib/errors.ts";
import { captureLog, credentialStoreStubs, configStubs } from "../../test/lib/stubs.ts";

const actualConstants = await import("../../lib/constants.ts");
const actualEnvironment = await import("../../lib/environment.ts");

const mockGetValidToken = mock();
const mockStoreToken = mock();
const mockCreateOAuthSession = mock();
const mockGetAuth = mock();
const mockSetAuth = mock();
const mockResolveProfile = mock();
const mockExchangeCodeForToken = mock();
const mockFetchUserInfo = mock();
const mockStartAuthServer = mock();
const mockIsHuman = mock();
const mockConfirm = mock();
const mockOpenBrowser = mock();
const mockEnsureFirstApplication = mock<() => Promise<void>>(() => Promise.resolve());

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
  storeToken: (...args: unknown[]) => mockStoreToken(...args),
  createOAuthSession: (...args: unknown[]) => mockCreateOAuthSession(...args),
}));

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  setAuth: (...args: unknown[]) => mockSetAuth(...args),
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

mock.module("../../lib/token-exchange.ts", () => ({
  exchangeCodeForToken: (...args: unknown[]) => mockExchangeCodeForToken(...args),
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

mock.module("../../lib/environment.ts", () => ({
  ...actualEnvironment,
  getOAuthConfig: () => ({
    clientId: "test-client-id",
    scopes: "profile email",
    authorizeUrl: "https://test.example.com/oauth/authorize",
    tokenUrl: "https://test.example.com/oauth/token",
    userinfoUrl: "https://test.example.com/oauth/userinfo",
  }),
}));

mock.module("../../lib/constants.ts", () => ({
  ...actualConstants,
  CALLBACK_PATH: "/callback",
  AUTH_TIMEOUT_MS: 120000,
  CLERK_CLIENT_CLI: "cli",
}));

mock.module("../../lib/pkce.ts", () => ({
  generateCodeVerifier: () => "test-code-verifier",
  generateCodeChallenge: async () => "test-code-challenge",
  generateState: () => "test-state-value",
}));

mock.module("../../lib/auth-server.ts", () => ({
  startAuthServer: (...args: unknown[]) => mockStartAuthServer(...args),
}));

mock.module("../../mode.ts", () => ({
  isHuman: (...args: unknown[]) => mockIsHuman(...args),
  isAgent: () => !mockIsHuman(),
  getMode: () => (mockIsHuman() ? "human" : "agent"),
  setMode: () => {},
}));

mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

mock.module("../../lib/open.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

mock.module("../../lib/first-application.ts", () => ({
  ensureFirstApplication: () => mockEnsureFirstApplication(),
}));

mock.module("../../lib/autoclaim.ts", () => ({
  attemptAutoclaim: async () => ({ status: "not_keyless" }),
}));

const { login } = await import("./login.ts");

describe("login", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;
  const origSpawn = Bun.spawn;

  beforeEach(() => {
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockGetValidToken.mockReset();
    mockStoreToken.mockReset();
    mockCreateOAuthSession.mockReset();
    mockGetAuth.mockReset();
    mockSetAuth.mockReset();
    mockResolveProfile.mockReset();
    mockExchangeCodeForToken.mockReset();
    mockFetchUserInfo.mockReset();
    mockStartAuthServer.mockReset();
    mockIsHuman.mockReset();
    mockConfirm.mockReset();
    mockOpenBrowser.mockReset();
    mockEnsureFirstApplication.mockReset();
    mockEnsureFirstApplication.mockResolvedValue(undefined);
    mockIsHuman.mockReturnValue(false);
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "test" });
    consoleSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    try {
      (Bun as any).spawn = origSpawn;
    } catch {
      // Bun.spawn may not be writable
    }
  });

  function runLogin(options?: Parameters<typeof login>[0]) {
    return captured.run(() => login(options));
  }

  function mockBunSpawn() {
    try {
      (Bun as any).spawn = mock(() => ({ exited: Promise.resolve(0) }));
    } catch {
      // Bun.spawn may not be writable on some runtimes
    }
  }

  test("returns early when already authenticated with valid token", async () => {
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "existing@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await runLogin();

    expect(result).toEqual({ userId: "user_123", email: "existing@example.com" });
    expect(captured.err).toContain("Logged in as existing@example.com");
    expect(mockStartAuthServer).not.toHaveBeenCalled();
  });

  test("performs fresh login when no token exists", async () => {
    mockGetValidToken.mockResolvedValue(null);
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
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await runLogin();

    expect(result).toEqual({ userId: "user_new", email: "new@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalledWith("test-state-value");
    expect(mockExchangeCodeForToken).toHaveBeenCalledWith({
      code: "fresh-auth-code",
      codeVerifier: "test-code-verifier",
      redirectUri: "http://127.0.0.1:54321/callback",
    });
    expect(mockCreateOAuthSession).toHaveBeenCalledWith({
      access_token: "new-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh-token",
    });
    expect(mockStoreToken).toHaveBeenCalledWith({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    expect(mockSetAuth).toHaveBeenCalledWith({ userId: "user_new" });
    expect(captured.err).toContain("Logged in as new@example.com");
  });

  test("re-authenticates when existing token is expired", async () => {
    mockGetValidToken.mockRejectedValue(new AuthError({ reason: "session_expired" }));
    mockGetAuth.mockResolvedValue({ userId: "user_old" });
    mockFetchUserInfo.mockResolvedValueOnce({
      userId: "user_refreshed",
      email: "refreshed@example.com",
    });
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
      refresh_token: "refreshed-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "refreshed-token",
      refreshToken: "refreshed-refresh-token",
      expiresAt: 456,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await runLogin();

    expect(result).toEqual({ userId: "user_refreshed", email: "refreshed@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalled();
    expect(mockStoreToken).toHaveBeenCalledWith({
      accessToken: "refreshed-token",
      refreshToken: "refreshed-refresh-token",
      expiresAt: 456,
      tokenType: "Bearer",
    });
  });

  test("stops auth server and throws when callback fails", async () => {
    mockGetValidToken.mockResolvedValue(null);
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

    await expect(runLogin()).rejects.toThrow("Authentication timed out");
    expect(mockServer.stop).toHaveBeenCalled();
  });

  test("proceeds with login when token exists but no auth config", async () => {
    mockGetValidToken.mockResolvedValue("orphan-token");
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
      refresh_token: "brand-new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "brand-new-token",
      refreshToken: "brand-new-refresh-token",
      expiresAt: 789,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_brand_new",
      email: "brandnew@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await runLogin();

    expect(result).toEqual({ userId: "user_brand_new", email: "brandnew@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalled();
  });

  test("in agent mode, returns early without prompting when already authenticated", async () => {
    mockIsHuman.mockReturnValue(false);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "agent@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await runLogin();

    expect(result).toEqual({ userId: "user_123", email: "agent@example.com" });
    expect(captured.err).toContain("Logged in as agent@example.com");
    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockStartAuthServer).not.toHaveBeenCalled();
  });

  test("in human mode, prompts and runs OAuth when user accepts re-auth", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo
      .mockResolvedValueOnce({ userId: "user_123", email: "old@example.com" })
      .mockResolvedValueOnce({ userId: "user_new", email: "new@example.com" });
    mockConfirm.mockResolvedValue(true);
    mockBunSpawn();

    const mockServer = {
      port: 54321,
      waitForCallback: mock().mockResolvedValue({ code: "reauth-code" }),
      stop: mock(),
    };
    mockStartAuthServer.mockReturnValue(mockServer);

    mockExchangeCodeForToken.mockResolvedValue({
      access_token: "new-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-token",
      refreshToken: "new-refresh-token",
      expiresAt: 999,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const result = await runLogin();

    expect(mockConfirm).toHaveBeenCalledWith({
      message: "You're already logged in as old@example.com. Re-authenticate?",
      default: false,
    });
    expect(result).toEqual({ userId: "user_new", email: "new@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalled();
  });

  test("in human mode, throws UserAbortError when user declines re-auth", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "current@example.com",
    });
    mockConfirm.mockResolvedValue(false);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await expect(runLogin()).rejects.toThrow("User aborted");
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockStartAuthServer).not.toHaveBeenCalled();
  });

  test("shows linked app with name and id in next steps when linked", async () => {
    mockGetValidToken.mockResolvedValue(null);
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
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);
    mockResolveProfile.mockResolvedValue({
      path: "/some/path",
      profile: {
        workspaceId: "ws_123",
        appId: "app_abc123",
        appName: "My App",
        instances: { development: "ins_dev" },
      },
      resolvedVia: "remote",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogin();

    expect(captured.err).toContain("Linked to `My App` (app_abc123)");
  });

  test("shows linked app with only id when appName is missing", async () => {
    mockGetValidToken.mockResolvedValue(null);
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
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);
    mockResolveProfile.mockResolvedValue({
      path: "/some/path",
      profile: {
        workspaceId: "ws_123",
        appId: "app_abc123",
        instances: { development: "ins_dev" },
      },
      resolvedVia: "remote",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogin();

    expect(captured.err).toContain("Linked to `app_abc123`");
  });

  test("shows default next steps when not linked", async () => {
    mockGetValidToken.mockResolvedValue(null);
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
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);
    mockResolveProfile.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogin();

    expect(captured.err).not.toContain("Linked to");
  });

  test("authorize URL includes clerk_client=cli so dashboard recognizes CLI sign-up", async () => {
    mockGetValidToken.mockResolvedValue(null);
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
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogin({ showNextSteps: false });

    expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
    const urlString = mockOpenBrowser.mock.calls[0]?.[0] as string;
    const parsed = new URL(urlString);
    expect(parsed.searchParams.get("clerk_client")).toBe("cli");
  });

  test("calls ensureFirstApplication after a successful OAuth flow", async () => {
    mockGetValidToken.mockResolvedValue(null);
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
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogin({ showNextSteps: false });

    expect(mockEnsureFirstApplication).toHaveBeenCalledTimes(1);
  });

  test("does not call ensureFirstApplication when existing session is reused", async () => {
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "existing@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runLogin();

    expect(mockEnsureFirstApplication).not.toHaveBeenCalled();
  });

  test("suppresses auth next-steps when requested", async () => {
    mockGetValidToken.mockResolvedValue(null);
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
      refresh_token: "new-refresh-token",
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: "new-access-token",
      refreshToken: "new-refresh-token",
      expiresAt: 123,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_new",
      email: "new@example.com",
    });
    mockSetAuth.mockResolvedValue(undefined);

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    await runLogin({ showNextSteps: false });

    expect(captured.err).not.toContain("Next steps:");
  });
});
