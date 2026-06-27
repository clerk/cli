import { test, expect, describe, beforeEach, afterAll, mock, setDefaultTimeout } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ApiError, AuthError } from "./errors.ts";

// Keyring initialization can be slow on first access (macOS Keychain, etc.)
setDefaultTimeout(5_000);

const tempDir = await mkdtemp(join(tmpdir(), "clerk-cred-test-"));
process.env.CLERK_CONFIG_DIR = tempDir;

const mockRefreshAccessToken = mock();

mock.module("@napi-rs/keyring", () => ({
  Entry: class {
    constructor() {
      throw new Error("keyring unavailable");
    }
  },
}));

mock.module("./version.ts", () => ({
  DEV_CLI_VERSION: "0.0.0-dev",
  resolveCliVersion: () => undefined,
}));

mock.module("./token-exchange.ts", () => ({
  refreshAccessToken: (...args: unknown[]) => mockRefreshAccessToken(...args),
}));

const {
  assertValidAccessToken,
  createOAuthSession,
  deleteToken,
  getJwtAuthorizedParty,
  getStoredSession,
  getToken,
  getValidToken,
  storeAccessToken,
  storeToken,
} = await import("./credential-store.ts");

/** Build a JWT-shaped token whose payload has the given fields. */
function buildJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

function jwtWithExp(expSeconds: number): string {
  return buildJwt({ exp: expSeconds });
}

async function writeLegacyToken(value: string): Promise<void> {
  await writeFile(join(tempDir, "credentials"), value, { mode: 0o600 });
}

afterAll(async () => {
  delete process.env.CLERK_CONFIG_DIR;
  await rm(tempDir, { recursive: true, force: true });
});

describe("credential-store", () => {
  beforeEach(async () => {
    mockRefreshAccessToken.mockReset();
    await deleteToken();
  });

  test("getToken returns null when no token is stored", async () => {
    expect(await getToken()).toBeNull();
  });

  test("getToken reads legacy token strings without a stored session", async () => {
    await writeLegacyToken("my-access-token");

    expect(await getToken()).toBe("my-access-token");
    expect(await getStoredSession()).toBeNull();
  });

  test("storeToken and getStoredSession roundtrip for OAuth sessions", async () => {
    const session = {
      accessToken: "session-access-token",
      refreshToken: "session-refresh-token",
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
    };

    await storeToken(session);

    expect(await getToken()).toBe(session.accessToken);
    expect(await getStoredSession()).toEqual(session);
  });

  test("getValidToken uses stored expiresAt before attempting refresh", async () => {
    const session = {
      accessToken: "opaque-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
    };

    await storeToken(session);

    expect(await getValidToken()).toBe("opaque-access-token");
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  test("getValidToken refreshes expired sessions and persists the new access token", async () => {
    const session = {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 60_000,
      tokenType: "Bearer",
    };
    await storeToken(session);

    mockRefreshAccessToken.mockResolvedValue({
      access_token: "refreshed-access-token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "rotated-refresh-token",
    });

    expect(await getValidToken()).toBe("refreshed-access-token");
    expect(mockRefreshAccessToken).toHaveBeenCalledWith("refresh-token");
    expect(await getStoredSession()).toEqual({
      accessToken: "refreshed-access-token",
      refreshToken: "rotated-refresh-token",
      expiresAt: expect.any(Number),
      tokenType: "Bearer",
    });
  });

  test("getValidToken recovers from a concurrent refresh race when another process completes the refresh first (invalid_grant)", async () => {
    const session = {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 60_000,
      tokenType: "Bearer",
    };
    const refreshedSession = {
      accessToken: "other-process-access-token",
      refreshToken: "other-process-refresh-token",
      expiresAt: Date.now() + 60_000,
      tokenType: "Bearer",
    };
    await storeToken(session);

    mockRefreshAccessToken.mockImplementation(async () => {
      setTimeout(() => {
        void storeToken(refreshedSession);
      }, 5);
      throw new ApiError(400, "invalid_grant");
    });

    expect(await getValidToken()).toBe("other-process-access-token");
    expect(await getStoredSession()).toEqual(refreshedSession);
  });

  test("getValidToken deletes stored credentials when refresh returns invalid_grant", async () => {
    const session = {
      accessToken: "expired-access-token",
      refreshToken: "refresh-token",
      expiresAt: Date.now() - 60_000,
      tokenType: "Bearer",
    };
    await storeToken(session);

    mockRefreshAccessToken.mockRejectedValue(new ApiError(400, "invalid_grant"));

    await expect(getValidToken()).rejects.toBeInstanceOf(AuthError);
    expect(await getToken()).toBeNull();
    expect(await getStoredSession()).toBeNull();
  });

  test("createOAuthSession requires a refresh token in the auth response", () => {
    expect(() =>
      createOAuthSession({
        access_token: "new-access-token",
        token_type: "Bearer",
        expires_in: 3600,
      } as never),
    ).toThrow("Authentication response did not include a refresh token");
  });

  test("storeAccessToken persists a JWT and exposes it through getValidToken without refresh", async () => {
    const jwt = jwtWithExp(Math.floor(Date.now() / 1000) + 3600);
    await storeAccessToken(jwt);

    expect(await getToken()).toBe(jwt);
    expect(await getValidToken()).toBe(jwt);

    const session = await getStoredSession();
    expect(session?.refreshToken).toBe("");
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });

  test("storeAccessToken rejects non-JWT tokens with a clear secret-key hint", async () => {
    await expect(storeAccessToken("sk_test_not_a_jwt")).rejects.toThrow(/JWT|secret key/);
  });

  test("storeAccessToken rejects an already-expired token", async () => {
    const expiredJwt = jwtWithExp(Math.floor(Date.now() / 1000) - 60);
    await expect(storeAccessToken(expiredJwt)).rejects.toThrow(/already expired/);
  });

  test("storeAccessToken rejects a token that will expire within the refresh leeway window", async () => {
    // A token with ~5 s left would pass a naive `exp > now` check but
    // isExpiredSession treats anything inside the 30 s leeway as expired,
    // so accepting it would store a token that's instantly unusable.
    const aboutToExpire = jwtWithExp(Math.floor(Date.now() / 1000) + 5);
    await expect(storeAccessToken(aboutToExpire)).rejects.toThrow(/already expired/);
  });

  test("assertValidAccessToken rejects tokens larger than 8 KB", () => {
    const oversized = `a.${"x".repeat(9_000)}.sig`;
    expect(() => assertValidAccessToken(oversized)).toThrow(/maximum/);
  });

  test("assertValidAccessToken rejects strings that don't have three JWT segments", () => {
    expect(() => assertValidAccessToken("a.b")).toThrow(/JWT/);
    expect(() => assertValidAccessToken("a.b.c.d")).toThrow(/JWT/);
  });

  test("getJwtAuthorizedParty returns azp when present and null otherwise", () => {
    const exp = Math.floor(Date.now() / 1000) + 3600;
    expect(getJwtAuthorizedParty(buildJwt({ exp, azp: "clerk-cli" }))).toBe("clerk-cli");
    expect(getJwtAuthorizedParty(jwtWithExp(exp))).toBeNull();
    expect(getJwtAuthorizedParty("not.a.jwt-payload")).toBeNull();
  });

  test("getValidToken on an expired token-only session throws AUTH_REQUIRED instead of trying to refresh", async () => {
    // Manually store an expired session with no refresh token, mirroring the
    // state we'd be in after a CI token-login that has since aged out.
    await writeLegacyToken(
      JSON.stringify({
        accessToken: jwtWithExp(Math.floor(Date.now() / 1000) - 60),
        refreshToken: "",
        expiresAt: Date.now() - 60_000,
        tokenType: "Bearer",
      }),
    );

    await expect(getValidToken()).rejects.toThrow(/cannot be auto-refreshed/);
    expect(mockRefreshAccessToken).not.toHaveBeenCalled();
  });
});
