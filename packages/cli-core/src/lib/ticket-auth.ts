/**
 * Headless login with a single-use Dashboard sign-in ticket.
 *
 * Sequence: redeem the ticket for a transient FAPI session -> drive the OAuth
 * authorize step through the consent endpoint (consent granted in the request)
 * -> exchange the code (PKCE) -> revoke the transient session. The CLI ends up
 * holding exactly the credential the browser flow yields: the role-scoped
 * OAuth access token. The FAPI session exists only inside `loginWithTicket`.
 *
 * Requires Native API on the dashboard instance: a headless client has no
 * cookies, so FAPI hands the client credential back in the `Authorization`
 * response header only for native clients (`_is_native=1`).
 */

import { CALLBACK_PATH } from "./constants.ts";
import { getOAuthConfig } from "./environment.ts";
import { CliError, ERROR_CODE, FapiError } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";
import { generateCodeChallenge, generateCodeVerifier, generateState } from "./pkce.ts";
import { CLI_SIGINT_HANDLER } from "./signals.ts";
import { exchangeCodeForToken, type TokenResponse } from "./token-exchange.ts";

/**
 * Loopback redirect for the headless authorize call. FAPI accepts any port on
 * 127.0.0.1 (RFC 8252 §7.3) and the redirect is read from the response, never followed.
 */
const TICKET_REDIRECT_URI = `http://127.0.0.1:1${CALLBACK_PATH}`;

/** FAPI error codes that mean "do not retry this ticket". */
const TICKET_ERROR_MESSAGES: Record<
  string,
  { code: (typeof ERROR_CODE)[keyof typeof ERROR_CODE]; message: string }
> = {
  ticket_expired_code: {
    code: ERROR_CODE.TICKET_EXPIRED,
    message:
      "Sign-in ticket has expired. Copy a fresh prompt from the Clerk Dashboard, or run `clerk auth login` to sign in via the browser.",
  },
  sign_in_token_already_used_code: {
    code: ERROR_CODE.TICKET_ALREADY_USED,
    message:
      "Sign-in ticket was already used; each ticket works exactly once. Copy a fresh prompt from the Clerk Dashboard, or run `clerk auth login` to sign in via the browser.",
  },
  sign_in_token_revoked_code: {
    code: ERROR_CODE.TICKET_INVALID,
    message: "Sign-in ticket was revoked. Run `clerk auth login` to sign in via the browser.",
  },
  sign_in_token_cannot_be_used_code: {
    code: ERROR_CODE.TICKET_INVALID,
    message: "Sign-in ticket cannot be used. Run `clerk auth login` to sign in via the browser.",
  },
  ticket_invalid_code: {
    code: ERROR_CODE.TICKET_INVALID,
    message: "Sign-in ticket is invalid. Run `clerk auth login` to sign in via the browser.",
  },
};

interface TicketSession {
  clientJwt: string;
  sessionId: string;
}

function fapiUrl(path: string): URL {
  const url = new URL(path, getOAuthConfig().baseUrl);
  url.searchParams.set("_is_native", "1");
  return url;
}

async function throwTicketError(response: Response): Promise<never> {
  const body = await response.text();
  let code: string | undefined;
  try {
    code = (JSON.parse(body) as { errors?: { code?: string }[] }).errors?.[0]?.code;
  } catch {
    // non-JSON body; fall through to the generic FAPI error
  }
  const known = code ? TICKET_ERROR_MESSAGES[code] : undefined;
  if (known) throw new CliError(known.message, { code: known.code });
  throw FapiError.fromBody(response.status, body, response.url || undefined);
}

async function redeemTicket(ticket: string): Promise<TicketSession> {
  const response = await loggedFetch(fapiUrl("/v1/client/sign_ins"), {
    tag: "fapi",
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ strategy: "ticket", ticket }).toString(),
  });
  if (!response.ok) await throwTicketError(response);

  const body = (await response.json()) as {
    response?: { status?: string; created_session_id?: string };
  };
  const status = body.response?.status;
  if (status === "needs_second_factor") {
    throw new CliError(
      "This account requires a second factor, which a sign-in ticket cannot satisfy. Run `clerk auth login` to sign in via the browser.",
      { code: ERROR_CODE.MFA_REQUIRED },
    );
  }
  if (status !== "complete" || !body.response?.created_session_id) {
    throw new CliError(
      `Sign-in did not complete (status: ${status ?? "unknown"}). Run \`clerk auth login\` to sign in via the browser.`,
      {
        code: ERROR_CODE.TICKET_INVALID,
      },
    );
  }

  const clientJwt = response.headers.get("authorization");
  if (!clientJwt) {
    throw new CliError(
      "Frontend API did not return a client token; Native API must be enabled on the dashboard instance for headless login.",
      { code: ERROR_CODE.FAPI_ERROR },
    );
  }
  return { clientJwt, sessionId: body.response.created_session_id };
}

async function authorizeWithSession(
  session: TicketSession,
  pkce: { codeChallenge: string; state: string },
): Promise<string> {
  const oauth = getOAuthConfig();
  const params = new URLSearchParams({
    consented: "true",
    response_type: "code",
    client_id: oauth.clientId,
    redirect_uri: TICKET_REDIRECT_URI,
    scope: oauth.scopes,
    state: pkce.state,
    code_challenge: pkce.codeChallenge,
    code_challenge_method: "S256",
  });
  // The consent endpoint doubles as the authorize call when consent is
  // granted in the request; consent stays enabled on the OAuth app.
  const response = await loggedFetch(
    fapiUrl(`/v1/me/oauth/consent/${encodeURIComponent(oauth.clientId)}`),
    {
      tag: "fapi",
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: session.clientJwt,
        "Clerk-Session-Id": session.sessionId,
      },
      body: params.toString(),
      redirect: "manual",
    },
  );

  const location = response.headers.get("location");
  if (!location) await throwTicketError(response);
  const redirect = new URL(location!);
  const error = redirect.searchParams.get("error");
  if (error) {
    throw new CliError(
      `Authorization failed: ${error} ${redirect.searchParams.get("error_description") ?? ""}`.trim(),
      {
        code: ERROR_CODE.FAPI_ERROR,
      },
    );
  }
  if (redirect.searchParams.get("state") !== pkce.state) {
    throw new Error("Invalid state parameter. Possible CSRF attack.");
  }
  const code = redirect.searchParams.get("code");
  if (!code) throw new Error("No authorization code received.");
  return code;
}

async function revokeSession(session: TicketSession): Promise<void> {
  try {
    const response = await loggedFetch(fapiUrl(`/v1/client/sessions/${session.sessionId}/remove`), {
      tag: "fapi",
      method: "POST",
      headers: { Authorization: session.clientJwt },
    });
    if (!response.ok)
      log.warn(`Could not revoke the transient sign-in session (${response.status}).`);
  } catch (error) {
    log.warn(
      `Could not revoke the transient sign-in session: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Redeem a single-use sign-in ticket for an OAuth token response. The
 * transient FAPI session is revoked on every exit path, including Ctrl+C.
 */
export async function loginWithTicket(ticket: string): Promise<TokenResponse> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
  const state = generateState();

  const session = await redeemTicket(ticket);

  // Swap the default Ctrl+C handler for one that revokes the session first.
  const onSigint = () => {
    void revokeSession(session).finally(CLI_SIGINT_HANDLER);
  };
  process.removeListener("SIGINT", CLI_SIGINT_HANDLER);
  process.once("SIGINT", onSigint);
  try {
    const code = await authorizeWithSession(session, { codeChallenge, state });
    return await exchangeCodeForToken({ code, codeVerifier, redirectUri: TICKET_REDIRECT_URI });
  } finally {
    process.removeListener("SIGINT", onSigint);
    process.on("SIGINT", CLI_SIGINT_HANDLER);
    await revokeSession(session);
  }
}
