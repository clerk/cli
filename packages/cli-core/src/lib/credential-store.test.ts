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

const { createOAuthSession, deleteToken, getStoredSession, getToken, getValidToken, storeToken } =
  await import("./credential-store.ts");

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
});
