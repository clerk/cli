import { test, expect, describe, afterEach, mock } from "bun:test";
import {
  exchangeCodeForToken,
  refreshAccessToken,
  revokeToken,
  fetchUserInfo,
} from "./token-exchange.ts";
import { setLogLevel } from "./log.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

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
    expect(calledInit.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");

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
    ).rejects.toThrow("invalid_grant");
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
    expect(init.headers.get("Authorization")).toBe("Bearer my-secret-token");
  });

  test("throws on non-OK response with status code", async () => {
    globalThis.fetch = mock(async () => {
      return new Response("Unauthorized", { status: 401 });
    }) as unknown as typeof fetch;

    await expect(fetchUserInfo("expired-token")).rejects.toThrow("Unauthorized");
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
    expect(calledInit.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(calledInit.body);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-token-123");
  });
});

describe("revokeToken", () => {
  const captured = useCaptureLog();

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("posts the token, hint, and client_id to the revocation endpoint", async () => {
    globalThis.fetch = mock(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    expect(await revokeToken("refresh-token-123", "refresh_token")).toBe("revoked");

    expect(globalThis.fetch).toHaveBeenCalledTimes(1);

    const [calledUrl, calledInit] = (globalThis.fetch as unknown as ReturnType<typeof mock>).mock
      .calls[0]!;
    expect(String(calledUrl)).toContain("/oauth/token/revoke");
    expect(calledInit.method).toBe("POST");
    expect(calledInit.headers.get("Content-Type")).toBe("application/x-www-form-urlencoded");

    const body = new URLSearchParams(calledInit.body);
    expect(body.get("token")).toBe("refresh-token-123");
    expect(body.get("token_type_hint")).toBe("refresh_token");
    expect(body.get("client_id")).toBeTruthy();
  });

  test("reports failure when the endpoint returns an error status", async () => {
    globalThis.fetch = mock(
      async () => new Response(JSON.stringify({ error: "invalid_request" }), { status: 400 }),
    ) as unknown as typeof fetch;

    // A permanent 4xx must not read as success, or a misconfigured client
    // silently never revokes anything while reporting a clean logout.
    expect(await revokeToken("spent-token", "refresh_token")).toBe("failed");
  });

  test("reports failure without throwing when the request fails outright", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    expect(await revokeToken("refresh-token-123", "refresh_token")).toBe("failed");
  });

  test("reports failure without throwing when the OAuth base URL is malformed", async () => {
    const previous = process.env.CLERK_OAUTH_BASE_URL;
    process.env.CLERK_OAUTH_BASE_URL = "not-a-url";
    globalThis.fetch = mock(
      async () => new Response("", { status: 200 }),
    ) as unknown as typeof fetch;

    try {
      // Resolving the config throws here. If that escapes, it aborts the
      // caller's teardown partway through — credentials deleted, config left
      // stale. It must surface as a failed result instead.
      expect(await revokeToken("refresh-token-123", "refresh_token")).toBe("failed");
      expect(globalThis.fetch).not.toHaveBeenCalled();
    } finally {
      if (previous === undefined) delete process.env.CLERK_OAUTH_BASE_URL;
      else process.env.CLERK_OAUTH_BASE_URL = previous;
    }
  });

  test("logs the failure reason under --verbose", async () => {
    globalThis.fetch = mock(async () => {
      throw new Error("network unreachable");
    }) as unknown as typeof fetch;

    setLogLevel("debug");
    try {
      await revokeToken("refresh-token-123", "refresh_token");
    } finally {
      setLogLevel("info");
    }

    expect(captured.err).toContain("token revocation failed");
  });
});
