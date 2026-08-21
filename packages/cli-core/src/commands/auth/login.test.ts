import { test, expect, describe, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { AuthError } from "../../lib/errors.ts";
import { useCaptureLog, credentialStoreStubs, configStubs } from "../../test/lib/stubs.ts";

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
const mockRevokeToken = mock();
const mockGetStoredSession = mock();
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
  getStoredSession: (...args: unknown[]) => mockGetStoredSession(...args),
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
  revokeToken: (...args: unknown[]) => mockRevokeToken(...args),
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
  generateCodeChallenge: () => "test-code-challenge",
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
  text: async () => "",
  password: async () => "",
  editor: async () => "",
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

const { setLogLevel } = await import("../../lib/log.ts");
const { login } = await import("./login.ts");

describe("login", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();
  const origSpawn = Bun.spawn;

  beforeEach(() => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    mockGetValidToken.mockReset();
    mockStoreToken.mockReset();
    mockCreateOAuthSession.mockReset();
    mockGetAuth.mockReset();
    mockSetAuth.mockReset();
    mockResolveProfile.mockReset();
    mockExchangeCodeForToken.mockReset();
    mockFetchUserInfo.mockReset();
    mockRevokeToken.mockReset();
    mockGetStoredSession.mockReset();
    mockStartAuthServer.mockReset();
    mockIsHuman.mockReset();
    mockConfirm.mockReset();
    mockOpenBrowser.mockReset();
    mockEnsureFirstApplication.mockReset();
    mockEnsureFirstApplication.mockResolvedValue(undefined);
    mockIsHuman.mockReturnValue(false);
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "test" });
    mockRevokeToken.mockResolvedValue("revoked");
    mockGetStoredSession.mockResolvedValue(null);
    setLogLevel("info");
    consoleSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    try {
      (Bun as any).spawn = origSpawn;
    } catch {
      // Bun.spawn may not be writable
    }
  });

  function runLogin(options?: Parameters<typeof login>[0]) {
    return login(options);
  }

  function mockBunSpawn() {
    try {
      (Bun as any).spawn = mock(() => ({ exited: Promise.resolve(0) }));
    } catch {
      // Bun.spawn may not be writable on some runtimes
    }
  }

  interface OAuthFlowOverrides {
    code?: string;
    tokens?: { accessToken: string; refreshToken: string; expiresAt: number };
    /** Pass null when the test wires mockFetchUserInfo itself (e.g. resolveOnce chains). */
    user?: { userId: string; email: string } | null;
  }

  /** Arrange every mock a successful OAuth flow needs; returns the auth server stub. */
  function mockOAuthSuccess(overrides: OAuthFlowOverrides = {}) {
    const {
      code = "fresh-auth-code",
      tokens = {
        accessToken: "new-access-token",
        refreshToken: "new-refresh-token",
        expiresAt: 123,
      },
      user = { userId: "user_new", email: "new@example.com" },
    } = overrides;

    mockBunSpawn();
    const server = {
      port: 54321,
      waitForCallback: mock().mockResolvedValue({ code }),
      stop: mock(),
    };
    mockStartAuthServer.mockReturnValue(server);
    mockExchangeCodeForToken.mockResolvedValue({
      access_token: tokens.accessToken,
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: tokens.refreshToken,
    });
    mockCreateOAuthSession.mockReturnValue({
      accessToken: tokens.accessToken,
      refreshToken: tokens.refreshToken,
      expiresAt: tokens.expiresAt,
      tokenType: "Bearer",
    });
    mockStoreToken.mockResolvedValue(undefined);
    mockSetAuth.mockResolvedValue(undefined);
    if (user) mockFetchUserInfo.mockResolvedValue(user);
    return server;
  }

  test("returns early when already authenticated with valid token", async () => {
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "existing@example.com",
    });

    const result = await runLogin();

    expect(result).toEqual({ userId: "user_123", email: "existing@example.com" });
    expect(captured.err).toContain("Logged in as existing@example.com");
    expect(mockStartAuthServer).not.toHaveBeenCalled();
  });

  test("performs fresh login when no token exists", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();

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
    mockOAuthSuccess({
      code: "refresh-code",
      tokens: {
        accessToken: "refreshed-token",
        refreshToken: "refreshed-refresh-token",
        expiresAt: 456,
      },
      user: null,
    });

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

    await expect(runLogin()).rejects.toThrow("Authentication timed out");
    expect(mockServer.stop).toHaveBeenCalled();
  });

  test("proceeds with login when token exists but no auth config", async () => {
    mockGetValidToken.mockResolvedValue("orphan-token");
    mockGetAuth.mockResolvedValue(undefined);
    mockOAuthSuccess({ user: { userId: "user_brand_new", email: "brandnew@example.com" } });

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
    mockOAuthSuccess({ code: "reauth-code", user: null });

    const result = await runLogin();

    expect(mockConfirm).toHaveBeenCalledWith({
      message: "You're already logged in as old@example.com. Re-authenticate?",
      default: false,
    });
    expect(result).toEqual({ userId: "user_new", email: "new@example.com" });
    expect(mockStartAuthServer).toHaveBeenCalled();
  });

  test("in human mode, skips prompt and runs OAuth when yes is true", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockFetchUserInfo
      .mockResolvedValueOnce({ userId: "user_123", email: "old@example.com" })
      .mockResolvedValueOnce({ userId: "user_new", email: "new@example.com" });
    mockOAuthSuccess({ code: "reauth-code", user: null });

    const result = await runLogin({ yes: true });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockStartAuthServer).toHaveBeenCalled();
    expect(result).toEqual({ userId: "user_new", email: "new@example.com" });
  });

  /**
   * Wires getStoredSession/storeToken as a single stateful store, so that
   * storing the new session changes what a subsequent read returns. A stateless
   * mock cannot distinguish "captured the outgoing session" from "captured the
   * one we just created", which is the refactor these tests exist to catch.
   */
  function useStatefulCredentialStore(initial: Record<string, unknown> | null) {
    let stored = initial;
    mockGetStoredSession.mockImplementation(async () => stored);
    mockStoreToken.mockImplementation(async (session: unknown) => {
      stored = session as Record<string, unknown>;
    });
    return {
      current: () => stored,
    };
  }

  const OLD_SESSION = {
    accessToken: "old-access-token",
    refreshToken: "old-refresh-token",
    expiresAt: Date.now() + 60_000,
    tokenType: "Bearer",
  };

  test("revokes the superseded grant after re-authenticating", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    useStatefulCredentialStore(OLD_SESSION);
    mockFetchUserInfo
      .mockResolvedValueOnce({ userId: "user_123", email: "old@example.com" })
      .mockResolvedValueOnce({ userId: "user_new", email: "new@example.com" });
    mockConfirm.mockResolvedValue(true);
    mockOAuthSuccess({ code: "reauth-code", user: null });

    await runLogin();

    // The OLD refresh token, not the newly minted one. With a stateful store
    // this fails if the capture moves below the token exchange.
    expect(mockRevokeToken).toHaveBeenCalledWith("old-refresh-token", "refresh_token");
    // The replacement must be stored before the old grant is torn down.
    expect(mockStoreToken.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRevokeToken.mock.invocationCallOrder[0]!,
    );
    // …and the capture must happen before the store, or it reads the new one.
    expect(mockGetStoredSession.mock.invocationCallOrder.at(-1)!).toBeLessThan(
      mockStoreToken.mock.invocationCallOrder[0]!,
    );
  });

  test("revokes the outgoing grant even when the session pre-check fails", async () => {
    mockIsHuman.mockReturnValue(true);
    // A live session exists in the store, but the pre-flight probe blows up.
    // getExistingSession swallows it, so `existingSession` is null — the old
    // grant must still be revoked rather than orphaned.
    mockGetValidToken.mockRejectedValue(new Error("network unreachable"));
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    useStatefulCredentialStore(OLD_SESSION);
    mockFetchUserInfo.mockResolvedValue({ userId: "user_new", email: "new@example.com" });
    mockOAuthSuccess({ code: "reauth-code", user: null });

    await runLogin();

    expect(mockRevokeToken).toHaveBeenCalledWith("old-refresh-token", "refresh_token");
  });

  test("warns when the superseded grant could not be revoked", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    useStatefulCredentialStore(OLD_SESSION);
    mockFetchUserInfo
      .mockResolvedValueOnce({ userId: "user_123", email: "old@example.com" })
      .mockResolvedValueOnce({ userId: "user_new", email: "new@example.com" });
    mockConfirm.mockResolvedValue(true);
    mockRevokeToken.mockResolvedValue("failed");
    mockOAuthSuccess({ code: "reauth-code", user: null });

    await runLogin();

    expect(captured.err).toContain("could not be revoked");
  });

  test("does not revoke anything when logging in without an existing session", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue(null);
    mockGetAuth.mockResolvedValue(null);
    useStatefulCredentialStore(null);
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "new@example.com" });
    mockOAuthSuccess({ code: "fresh-code", user: null });

    await runLogin();

    expect(mockRevokeToken).not.toHaveBeenCalled();
  });

  test("leaves the existing session intact when the browser flow fails", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: "user_123" });
    mockGetStoredSession.mockResolvedValue({
      accessToken: "old-access-token",
      refreshToken: "old-refresh-token",
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
    });
    mockFetchUserInfo.mockResolvedValueOnce({ userId: "user_123", email: "old@example.com" });
    mockConfirm.mockResolvedValue(true);
    mockStartAuthServer.mockReturnValue({
      port: 3000,
      waitForCallback: () => Promise.reject(new Error("Authentication timed out.")),
      stop: () => {},
    });

    await expect(runLogin()).rejects.toThrow("Authentication timed out.");
    expect(mockRevokeToken).not.toHaveBeenCalled();
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

    await expect(runLogin()).rejects.toThrow("User aborted");
    expect(mockConfirm).toHaveBeenCalled();
    expect(mockStartAuthServer).not.toHaveBeenCalled();
  });

  test("shows linked app with name and id in next steps when linked", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();
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

    await runLogin();

    expect(captured.err).toContain("Linked to `My App` (app_abc123)");
  });

  test("shows linked app with only id when appName is missing", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();
    mockResolveProfile.mockResolvedValue({
      path: "/some/path",
      profile: {
        workspaceId: "ws_123",
        appId: "app_abc123",
        instances: { development: "ins_dev" },
      },
      resolvedVia: "remote",
    });

    await runLogin();

    expect(captured.err).toContain("Linked to `app_abc123`");
  });

  test("shows default next steps when not linked", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();
    mockResolveProfile.mockResolvedValue(undefined);

    await runLogin();

    expect(captured.err).not.toContain("Linked to");
  });

  test("authorize URL includes clerk_client=cli so dashboard recognizes CLI sign-up", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();

    await runLogin({ showNextSteps: false });

    expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
    const urlString = mockOpenBrowser.mock.calls[0]?.[0] as string;
    const parsed = new URL(urlString);
    expect(parsed.searchParams.get("clerk_client")).toBe("cli");
  });

  test("always prints the authorize URL as a manual fallback, even when the browser opens", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });

    await runLogin({ showNextSteps: false });

    expect(captured.err).toContain("https://test.example.com/oauth/authorize");
    expect(captured.err).toContain("If it doesn't open, use this URL");
  });

  test("warns when the browser cannot be opened, pointing at the printed URL", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();
    mockOpenBrowser.mockResolvedValue({ ok: false, reason: "no-launcher" });

    await runLogin({ showNextSteps: false });

    expect(captured.err).toContain("https://test.example.com/oauth/authorize");
    expect(captured.err).toContain("Could not open your browser automatically");
  });

  test("does not emit the PKCE code verifier through debug logging", async () => {
    setLogLevel("debug");
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();

    await runLogin({ showNextSteps: false });

    // The authorize URL (containing state + code_challenge) is printed on
    // purpose as the manual fallback. The code verifier is the secret that
    // makes possession of that URL useless to an attacker — it must never
    // appear in any output.
    expect(captured.err).not.toContain("test-code-verifier");
  });

  test("calls ensureFirstApplication after a successful OAuth flow", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();

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

    await runLogin();

    expect(mockEnsureFirstApplication).not.toHaveBeenCalled();
  });

  test("suppresses auth next-steps when requested", async () => {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess();
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});

    await runLogin({ showNextSteps: false });

    expect(captured.err).not.toContain("Next steps:");
  });
});
