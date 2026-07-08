import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { AuthError } from "../../lib/errors.ts";

const mockGetValidToken = mock();
mock.module("../../lib/credential-store.ts", () => ({
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

const mockFetchUserInfo = mock();
mock.module("../../lib/token-exchange.ts", () => ({
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

const { requireLoginEmail, buildActorStamp, CLERK_CLI_ISSUER } = await import("./actor.ts");

describe("requireLoginEmail", () => {
  beforeEach(() => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_admin", email: "admin@example.com" });
  });

  afterEach(() => {
    mockGetValidToken.mockReset();
    mockFetchUserInfo.mockReset();
  });

  test("returns the login email when a valid token exists", async () => {
    await expect(requireLoginEmail()).resolves.toBe("admin@example.com");
  });

  test("throws AuthError(not_logged_in) when there is no stored token", async () => {
    mockGetValidToken.mockResolvedValue(null);

    let error: unknown;
    try {
      await requireLoginEmail();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).reason).toBe("not_logged_in");
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("throws AuthError(session_expired) when fetchUserInfo fails", async () => {
    mockFetchUserInfo.mockRejectedValue(new Error("401"));

    let error: unknown;
    try {
      await requireLoginEmail();
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AuthError);
    expect((error as AuthError).reason).toBe("session_expired");
  });
});

describe("buildActorStamp", () => {
  test("stamps `cli:<login-email>` with no --actor context", () => {
    expect(buildActorStamp("admin@example.com")).toEqual({
      sub: "cli:admin@example.com",
      iss: CLERK_CLI_ISSUER,
    });
  });

  test("appends `+<context>` when a --actor context is supplied", () => {
    expect(buildActorStamp("admin@example.com", "oncall")).toEqual({
      sub: "cli:admin@example.com+oncall",
      iss: CLERK_CLI_ISSUER,
    });
  });

  test("does not attempt to parse `+` characters already present in the email", () => {
    // Emails can legally contain '+' (plus-addressing). The stamp is a
    // write-only audit label — this locks in that we never try to be clever
    // about splitting it back apart.
    expect(buildActorStamp("admin+test@example.com", "oncall")).toEqual({
      sub: "cli:admin+test@example.com+oncall",
      iss: CLERK_CLI_ISSUER,
    });
  });
});
