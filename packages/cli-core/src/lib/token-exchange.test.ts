import { test, expect, describe, afterEach, mock } from "bun:test";
import { exchangeCodeForToken, refreshAccessToken, fetchUserInfo } from "./token-exchange.ts";

const originalFetch = globalThis.fetch;

describe("exchangeCodeForToken", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends correct parameters and returns token response", async () => {
    const tokenResponse = {
      access_token: "test-token-123",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-token-123",
    };

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(tokenResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await exchangeCodeForToken({
      code: "auth-code",
      codeVerifier: "test-verifier",
      redirectUri: "http://127.0.0.1:3000/callback",
    });

    expect(result).toEqual(tokenResponse);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [, calledInit] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(calledInit.body);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code");
    expect(body.get("code_verifier")).toBe("test-verifier");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:3000/callback");
  });

  test("includes refresh_token when present", async () => {
    const tokenResponse = {
      access_token: "token",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "refresh-123",
    };

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(tokenResponse), { status: 200 });
    }) as unknown as typeof fetch;

    const result = await exchangeCodeForToken({
      code: "code",
      codeVerifier: "verifier",
      redirectUri: "http://localhost/callback",
    });

    expect(result.refresh_token).toBe("refresh-123");
  });

  test("throws on non-OK response with status code", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("invalid_grant", { status: 400 });
    }) as unknown as typeof fetch;

    await expect(
      exchangeCodeForToken({
        code: "bad-code",
        codeVerifier: "verifier",
        redirectUri: "http://127.0.0.1:3000/callback",
      }),
    ).rejects.toThrow("API error (400)");
  });

  test("includes error body in thrown message", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("detailed error info", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(
      exchangeCodeForToken({
        code: "code",
        codeVerifier: "verifier",
        redirectUri: "http://localhost/callback",
      }),
    ).rejects.toThrow("detailed error info");
  });
});

describe("fetchUserInfo", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("returns userId and email from userinfo response", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(
        JSON.stringify({ sub: "user_abc", email: "user@example.com", name: "Test" }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;

    const result = await fetchUserInfo("valid-token");
    expect(result).toEqual({ userId: "user_abc", email: "user@example.com" });
  });

  test("sends Bearer token in Authorization header", async () => {
    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify({ sub: "u", email: "e" }), { status: 200 });
    }) as unknown as typeof fetch;

    await fetchUserInfo("my-secret-token");

    const [, init] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    expect(init.headers.Authorization).toBe("Bearer my-secret-token");
  });

  test("throws on non-OK response with status code", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(fetchUserInfo("expired-token")).rejects.toThrow("API error (401)");
  });

  test("includes response body in error message", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("token_revoked", { status: 403 });
    }) as unknown as typeof fetch;

    await expect(fetchUserInfo("bad")).rejects.toThrow("token_revoked");
  });
});

describe("refreshAccessToken", () => {
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("sends correct parameters and returns token response", async () => {
    const tokenResponse = {
      access_token: "refreshed-token-123",
      token_type: "Bearer",
      expires_in: 3600,
      refresh_token: "next-refresh-token",
    };

    globalThis.fetch = mock(async () => {
      return new Response(JSON.stringify(tokenResponse), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;

    const result = await refreshAccessToken("refresh-token-123");

    expect(result).toEqual(tokenResponse);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [, calledInit] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock.calls[0]!;
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers["Content-Type"]).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(calledInit.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token-123");
  });
});
