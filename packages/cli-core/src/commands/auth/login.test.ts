import { test, expect, describe, mock } from "bun:test";
import { login } from "./login.ts";
import { testRoot } from "../../test/lib/test-root.ts";
import type { AuthServerResult } from "../../lib/auth-server.ts";

interface MockAuthServerOptions {
  port?: number;
  code?: string;
  callbackError?: Error;
}

function makeMockAuthServer(opts: MockAuthServerOptions = {}): AuthServerResult & {
  stop: ReturnType<typeof mock>;
} {
  const stop = mock(() => {});
  return {
    port: opts.port ?? 54321,
    waitForCallback: async () => {
      if (opts.callbackError) throw opts.callbackError;
      return { code: opts.code ?? "test-code" };
    },
    stop,
  };
}

const OAUTH_CONFIG = {
  clientId: "test-client-id",
  scopes: "profile email",
  authorizeUrl: "https://test.example.com/oauth/authorize",
  tokenUrl: "https://test.example.com/oauth/token",
  userinfoUrl: "https://test.example.com/oauth/userinfo",
};

describe("login", () => {
  test("returns early when already authenticated with valid token", async () => {
    const deps = testRoot({
      credentialStore: { getToken: async () => "existing-token" },
      configStore: { getAuth: async () => ({ userId: "user_123" }) },
      tokenExchange: {
        fetchUserInfo: async () => ({ userId: "user_123", email: "existing@example.com" }),
      },
      mode: { isHuman: () => false },
    });

    const result = await login(deps);

    expect(result).toEqual({ userId: "user_123", email: "existing@example.com" });
    expect(deps.log.info).toHaveBeenCalledWith("Logged in as existing@example.com");
    // authServer.startAuthServer is strict-by-default, so an unintended call would throw.
  });

  test("performs fresh login when no token exists", async () => {
    const server = makeMockAuthServer({ port: 54321, code: "fresh-auth-code" });
    const deps = testRoot({
      credentialStore: {
        getToken: async () => null,
        storeToken: async () => {},
      },
      configStore: {
        setAuth: async () => {},
      },
      tokenExchange: {
        exchangeCodeForToken: async () => ({
          access_token: "new-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        fetchUserInfo: async () => ({ userId: "user_new", email: "new@example.com" }),
      },
      authServer: { startAuthServer: () => server },
      environment: { getOAuthConfig: () => OAUTH_CONFIG },
      browser: { open: async () => ({ ok: true }) },
      mode: { isHuman: () => false },
    });

    const result = await login(deps);

    expect(result).toEqual({ userId: "user_new", email: "new@example.com" });
    expect(deps.authServer.startAuthServer).toHaveBeenCalledWith("test-state");
    expect(deps.tokenExchange.exchangeCodeForToken).toHaveBeenCalledWith({
      code: "fresh-auth-code",
      codeVerifier: "test-verifier",
      redirectUri: "http://127.0.0.1:54321/callback",
    });
    expect(deps.credentialStore.storeToken).toHaveBeenCalledWith("new-access-token");
    expect(deps.configStore.setAuth).toHaveBeenCalledWith({ userId: "user_new" });
    expect(deps.log.info).toHaveBeenCalledWith("Logged in as new@example.com");
  });

  test("re-authenticates when existing token is expired", async () => {
    const server = makeMockAuthServer({ code: "refresh-code" });
    const fetchUserInfo = mock(async () => ({
      userId: "user_refreshed",
      email: "refreshed@example.com",
    }));
    // First call (during getExistingSession) throws to simulate expired token.
    fetchUserInfo.mockImplementationOnce(async () => {
      throw new Error("Token expired");
    });

    const deps = testRoot({
      credentialStore: {
        getToken: async () => "expired-token",
        storeToken: async () => {},
      },
      configStore: {
        getAuth: async () => ({ userId: "user_old" }),
        setAuth: async () => {},
      },
      tokenExchange: {
        exchangeCodeForToken: async () => ({
          access_token: "refreshed-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        fetchUserInfo,
      },
      authServer: { startAuthServer: () => server },
      environment: { getOAuthConfig: () => OAUTH_CONFIG },
      browser: { open: async () => ({ ok: true }) },
      mode: { isHuman: () => false },
    });

    const result = await login(deps);

    expect(result).toEqual({ userId: "user_refreshed", email: "refreshed@example.com" });
    expect(deps.authServer.startAuthServer).toHaveBeenCalled();
    expect(deps.credentialStore.storeToken).toHaveBeenCalledWith("refreshed-token");
  });

  test("stops auth server and throws when callback fails", async () => {
    const server = makeMockAuthServer({
      callbackError: new Error("Authentication timed out. Please try again."),
    });
    const deps = testRoot({
      credentialStore: { getToken: async () => null },
      authServer: { startAuthServer: () => server },
      environment: { getOAuthConfig: () => OAUTH_CONFIG },
      browser: { open: async () => ({ ok: true }) },
      mode: { isHuman: () => false },
    });

    await expect(login(deps)).rejects.toThrow("Authentication timed out");
    expect(server.stop).toHaveBeenCalled();
  });

  test("proceeds with login when token exists but no auth config", async () => {
    const server = makeMockAuthServer({ code: "new-code" });
    const deps = testRoot({
      credentialStore: {
        getToken: async () => "orphan-token",
        storeToken: async () => {},
      },
      configStore: {
        getAuth: async () => undefined,
        setAuth: async () => {},
      },
      tokenExchange: {
        exchangeCodeForToken: async () => ({
          access_token: "brand-new-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        fetchUserInfo: async () => ({
          userId: "user_brand_new",
          email: "brandnew@example.com",
        }),
      },
      authServer: { startAuthServer: () => server },
      environment: { getOAuthConfig: () => OAUTH_CONFIG },
      browser: { open: async () => ({ ok: true }) },
      mode: { isHuman: () => false },
    });

    const result = await login(deps);

    expect(result).toEqual({ userId: "user_brand_new", email: "brandnew@example.com" });
    expect(deps.authServer.startAuthServer).toHaveBeenCalled();
  });

  test("in agent mode, returns early without prompting when already authenticated", async () => {
    const deps = testRoot({
      credentialStore: { getToken: async () => "existing-token" },
      configStore: { getAuth: async () => ({ userId: "user_123" }) },
      tokenExchange: {
        fetchUserInfo: async () => ({ userId: "user_123", email: "agent@example.com" }),
      },
      mode: { isHuman: () => false },
    });

    const result = await login(deps);

    expect(result).toEqual({ userId: "user_123", email: "agent@example.com" });
    expect(deps.log.info).toHaveBeenCalledWith("Logged in as agent@example.com");
    expect(deps.prompts.confirm).not.toHaveBeenCalled();
  });

  test("in human mode, prompts and runs OAuth when user accepts re-auth", async () => {
    const server = makeMockAuthServer({ code: "reauth-code" });
    const fetchUserInfo = mock(async () => ({ userId: "user_new", email: "new@example.com" }));
    fetchUserInfo.mockImplementationOnce(async () => ({
      userId: "user_123",
      email: "old@example.com",
    }));

    const deps = testRoot({
      credentialStore: {
        getToken: async () => "existing-token",
        storeToken: async () => {},
      },
      configStore: {
        getAuth: async () => ({ userId: "user_123" }),
        setAuth: async () => {},
      },
      tokenExchange: {
        exchangeCodeForToken: async () => ({
          access_token: "new-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        fetchUserInfo,
      },
      authServer: { startAuthServer: () => server },
      environment: { getOAuthConfig: () => OAUTH_CONFIG },
      browser: { open: async () => ({ ok: true }) },
      prompts: { confirm: async () => true },
      mode: { isHuman: () => true },
    });

    const result = await login(deps);

    expect(deps.prompts.confirm).toHaveBeenCalledWith({
      message: "You're already logged in as old@example.com. Re-authenticate?",
      default: false,
    });
    expect(result).toEqual({ userId: "user_new", email: "new@example.com" });
    expect(deps.authServer.startAuthServer).toHaveBeenCalled();
  });

  test("in human mode, throws UserAbortError when user declines re-auth", async () => {
    const deps = testRoot({
      credentialStore: { getToken: async () => "existing-token" },
      configStore: { getAuth: async () => ({ userId: "user_123" }) },
      tokenExchange: {
        fetchUserInfo: async () => ({ userId: "user_123", email: "current@example.com" }),
      },
      prompts: { confirm: async () => false },
      mode: { isHuman: () => true },
    });

    await expect(login(deps)).rejects.toThrow("User aborted");
    expect(deps.prompts.confirm).toHaveBeenCalled();
    // authServer.startAuthServer is strict-by-default; an unintended call would throw.
  });

  test("suppresses auth next-steps when requested", async () => {
    const server = makeMockAuthServer({ code: "fresh-auth-code" });
    const deps = testRoot({
      credentialStore: {
        getToken: async () => null,
        storeToken: async () => {},
      },
      configStore: { setAuth: async () => {} },
      tokenExchange: {
        exchangeCodeForToken: async () => ({
          access_token: "new-access-token",
          token_type: "Bearer",
          expires_in: 3600,
        }),
        fetchUserInfo: async () => ({ userId: "user_new", email: "new@example.com" }),
      },
      authServer: { startAuthServer: () => server },
      environment: { getOAuthConfig: () => OAUTH_CONFIG },
      browser: { open: async () => ({ ok: true }) },
      mode: { isHuman: () => false },
    });

    await login(deps, { showNextSteps: false });

    // Verify outro was called with "Done" rather than the NEXT_STEPS list.
    expect(deps.spinner.outro).toHaveBeenCalledWith("Done");
  });
});
