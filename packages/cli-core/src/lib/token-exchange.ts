/**
 * OAuth token exchange and user info fetching against the Clerk system instance.
 *
 * All values can be overridden via environment variables for local development.
 * Bun auto-loads .env, so just add them to your .env file:
 *
 *   CLERK_OAUTH_CLIENT_ID=your_client_id
 *   CLERK_OAUTH_BASE_URL=https://your-dev-instance.clerk.accounts.dev
 *   CLERK_OAUTH_SCOPES=profile email
 */

import { getOAuthConfig } from "./environment.ts";
import { ApiError, errorMessage, withApiContext } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token: string;
}

/** `token_type_hint` values the revocation endpoint accepts (RFC 7009 §2.1). */
export type TokenTypeHint = "access_token" | "refresh_token";

/**
 * Outcome of a revocation attempt. `"failed"` means the server was not reached
 * or refused the request, so the grant should be assumed still live.
 */
export type RevocationResult = "revoked" | "failed";

export interface UserInfo {
  userId: string;
  email: string;
}

export async function exchangeCodeForToken(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const oauth = getOAuthConfig();
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: oauth.clientId,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });

  return withApiContext(
    (async () => {
      const response = await loggedFetch(oauth.tokenUrl, {
        tag: "oauth",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ApiError(response.status, error);
      }

      return response.json() as Promise<TokenResponse>;
    })(),
    "Token exchange failed",
  );
}

export async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const oauth = getOAuthConfig();
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: oauth.clientId,
  });

  return withApiContext(
    (async () => {
      const response = await loggedFetch(oauth.tokenUrl, {
        tag: "oauth",
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: body.toString(),
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ApiError(response.status, error);
      }

      return response.json() as Promise<TokenResponse>;
    })(),
    "Token refresh failed",
  );
}

/**
 * Revoke a token at the OAuth revocation endpoint (RFC 7009).
 *
 * Revoking a refresh token invalidates that token and, when the instance issues
 * opaque access tokens, the access token from the same grant. It does **not**
 * invalidate a JWT access token: the server refuses to revoke those outright
 * (`JWT access tokens cannot be revoked`), and a JWT stays valid until it
 * expires because it is verified by signature rather than by a lookup. Callers
 * must not describe revocation as ending the session everywhere.
 *
 * Never throws: the caller is already discarding the credentials, and a network
 * blip or a server error must not leave the user unable to log out. Failures
 * are reported through the return value and logged under `--verbose` so the
 * caller can tell the user rather than claiming a success that did not happen.
 *
 * Note that `"revoked"` is weaker than it looks. Per RFC 7009 §2.2 the endpoint
 * answers 200 for a token it does not recognise, and it also answers 200 for a
 * token that another process already rotated away — in that case the grant
 * survives under the new token and nothing was actually revoked.
 */
export async function revokeToken(
  token: string,
  tokenTypeHint: TokenTypeHint,
): Promise<RevocationResult> {
  try {
    // Inside the try: getOAuthConfig() parses URLs and throws on a malformed
    // CLERK_OAUTH_BASE_URL. Escaping here would abort the caller's teardown
    // partway through, which is exactly what this function promises not to do.
    const oauth = getOAuthConfig();
    const body = new URLSearchParams({
      token,
      token_type_hint: tokenTypeHint,
      client_id: oauth.clientId,
    });

    const response = await loggedFetch(oauth.revokeUrl, {
      tag: "oauth",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    // A 4xx here is permanent — a wrong client_id, or an instance whose OAuth
    // provider does not implement revocation. Without this check that failure
    // is indistinguishable from success on every run, forever.
    return response.ok ? "revoked" : "failed";
  } catch (error) {
    log.debug(`oauth: token revocation failed — ${errorMessage(error)}`);
    return "failed";
  }
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const oauth = getOAuthConfig();
  return withApiContext(
    (async () => {
      const response = await loggedFetch(oauth.userinfoUrl, {
        tag: "oauth",
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      if (!response.ok) {
        const error = await response.text();
        throw new ApiError(response.status, error);
      }

      const data = (await response.json()) as Record<string, unknown>;

      return {
        userId: data.sub as string,
        email: data.email as string,
      };
    })(),
    "Failed to fetch user info",
  );
}
