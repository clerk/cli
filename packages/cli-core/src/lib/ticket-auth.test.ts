import { test, expect, describe, beforeEach, mock } from "bun:test";
import { CliError, ERROR_CODE, FapiError } from "./errors.ts";

const mockLoggedFetch = mock<(url: URL, init: RequestInit) => Promise<Response>>();
const mockExchangeCodeForToken = mock();

mock.module("./fetch.ts", () => ({
  loggedFetch: (url: URL, init: RequestInit) => mockLoggedFetch(url, init),
}));
mock.module("./token-exchange.ts", () => ({
  exchangeCodeForToken: (...args: unknown[]) => mockExchangeCodeForToken(...args),
}));
mock.module("./environment.ts", () => ({
  getDashboardUrl: () => "https://dashboard.example.com/",
  getOAuthConfig: () => ({
    baseUrl: "https://clerk.example.com",
    clientId: "test-client-id",
    scopes: "",
    authorizeUrl: "https://clerk.example.com/oauth/authorize",
    tokenUrl: "https://clerk.example.com/oauth/token",
    userinfoUrl: "https://clerk.example.com/oauth/userinfo",
  }),
}));
mock.module("./pkce.ts", () => ({
  generateCodeVerifier: () => "test-code-verifier",
  generateCodeChallenge: () => "test-code-challenge",
  generateState: () => "test-state",
}));

const { loginWithTicket } = await import("./ticket-auth.ts");

const TOKEN_RESPONSE = {
  access_token: "access",
  refresh_token: "refresh",
  expires_in: 3600,
  token_type: "bearer",
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function redeemOk(): Response {
  return json(
    200,
    { response: { status: "complete", created_session_id: "sess_1" } },
    { "set-cookie": "__client=client-jwt; Path=/; HttpOnly; Secure; SameSite=Lax" },
  );
}

function consentRedirect(query: string): Response {
  return new Response(null, {
    status: 302,
    headers: { location: `http://127.0.0.1:1/callback?${query}` },
  });
}

/** Queue responses by path so the order of FAPI calls can be asserted. */
function route(handlers: Record<string, () => Response>) {
  mockLoggedFetch.mockImplementation(async (url) => {
    const handler = handlers[url.pathname];
    if (!handler) throw new Error(`unexpected fetch ${url.pathname}`);
    return handler();
  });
}

const calls = () => mockLoggedFetch.mock.calls.map(([url, init]) => ({ url, init }));
const removeCall = () =>
  calls().find((c) => c.url.pathname === "/v1/client/sessions/sess_1/remove");

describe("loginWithTicket", () => {
  beforeEach(() => {
    mockLoggedFetch.mockReset();
    mockExchangeCodeForToken.mockReset();
    mockExchangeCodeForToken.mockResolvedValue(TOKEN_RESPONSE);
  });

  test("redeems, authorizes through consent with the session id, exchanges, and revokes", async () => {
    route({
      "/v1/client/sign_ins": redeemOk,
      "/v1/me/oauth/consent/test-client-id": () =>
        consentRedirect("code=auth-code&state=test-state"),
      "/v1/client/sessions/sess_1/remove": () => json(200, {}),
    });

    const result = await loginWithTicket("ticket-jwt");

    expect(result).toEqual(TOKEN_RESPONSE);
    const [redeem, consent, remove] = calls();
    expect(redeem!.url.searchParams.has("_is_native")).toBe(false);
    expect(new Headers(redeem!.init.headers).get("origin")).toBe("https://dashboard.example.com");
    expect(String(redeem!.init.body)).toBe("strategy=ticket&ticket=ticket-jwt");
    expect(new Headers(consent!.init.headers).get("cookie")).toBe("__client=client-jwt");
    expect(new Headers(consent!.init.headers).get("origin")).toBe("https://dashboard.example.com");
    expect(new Headers(consent!.init.headers).get("clerk-session-id")).toBe("sess_1");
    expect(consent!.init.redirect).toBe("manual");
    const consentBody = new URLSearchParams(String(consent!.init.body));
    expect(consentBody.get("consented")).toBe("true");
    expect(consentBody.get("code_challenge")).toBe("test-code-challenge");
    expect(consentBody.get("redirect_uri")).toBe("http://127.0.0.1:1/callback");
    expect(new Headers(remove!.init.headers).get("cookie")).toBe("__client=client-jwt");
    expect(mockExchangeCodeForToken).toHaveBeenCalledWith({
      code: "auth-code",
      codeVerifier: "test-code-verifier",
      redirectUri: "http://127.0.0.1:1/callback",
    });
  });

  test.each([
    ["ticket_expired_code", ERROR_CODE.TICKET_EXPIRED],
    ["sign_in_token_already_used_code", ERROR_CODE.TICKET_ALREADY_USED],
    ["sign_in_token_revoked_code", ERROR_CODE.TICKET_INVALID],
    ["ticket_invalid_code", ERROR_CODE.TICKET_INVALID],
  ])("maps FAPI %s to a non-retryable %s error", async (fapiCode, cliCode) => {
    route({ "/v1/client/sign_ins": () => json(400, { errors: [{ code: fapiCode }] }) });

    const error = await loginWithTicket("ticket-jwt").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(cliCode);
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
    expect(calls()).toHaveLength(1);
  });

  test("refuses to complete an MFA-protected sign-in", async () => {
    route({
      "/v1/client/sign_ins": () => json(200, { response: { status: "needs_second_factor" } }),
    });

    const error = await loginWithTicket("ticket-jwt").catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.MFA_REQUIRED);
    expect((error as CliError).message).toContain("clerk auth login");
  });

  test("fails when FAPI returns no client cookie", async () => {
    route({
      "/v1/client/sign_ins": () =>
        json(200, { response: { status: "complete", created_session_id: "sess_1" } }),
    });

    const error = await loginWithTicket("ticket-jwt").catch((e: unknown) => e);

    expect((error as CliError).code).toBe(ERROR_CODE.FAPI_ERROR);
    expect((error as CliError).message).toContain("client cookie");
  });

  test("revokes the transient session when authorization fails", async () => {
    route({
      "/v1/client/sign_ins": redeemOk,
      "/v1/me/oauth/consent/test-client-id": () =>
        json(401, { errors: [{ code: "authentication_invalid" }] }),
      "/v1/client/sessions/sess_1/remove": () => json(200, {}),
    });

    const error = await loginWithTicket("ticket-jwt").catch((e: unknown) => e);

    expect(error).toBeInstanceOf(FapiError);
    expect(removeCall()).toBeDefined();
    expect(mockExchangeCodeForToken).not.toHaveBeenCalled();
  });

  test("revokes the transient session on a state mismatch", async () => {
    route({
      "/v1/client/sign_ins": redeemOk,
      "/v1/me/oauth/consent/test-client-id": () => consentRedirect("code=auth-code&state=wrong"),
      "/v1/client/sessions/sess_1/remove": () => json(200, {}),
    });

    const error = await loginWithTicket("ticket-jwt").catch((e: unknown) => e);

    expect((error as Error).message).toContain("Invalid state");
    expect(removeCall()).toBeDefined();
  });

  test("revokes the transient session when the token exchange fails", async () => {
    mockExchangeCodeForToken.mockRejectedValue(new Error("exchange down"));
    route({
      "/v1/client/sign_ins": redeemOk,
      "/v1/me/oauth/consent/test-client-id": () =>
        consentRedirect("code=auth-code&state=test-state"),
      "/v1/client/sessions/sess_1/remove": () => json(200, {}),
    });

    await expect(loginWithTicket("ticket-jwt")).rejects.toThrow("exchange down");
    expect(removeCall()).toBeDefined();
  });
});
