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
 * Revoking the refresh token invalidates the whole grant server-side, so a
 * stored session that has been discarded locally cannot be replayed by anyone
 * who recovered it from a backup, a shared machine, or a CI cache.
 *
 * Best-effort by contract: the caller is already discarding the credentials,
 * and a network blip or a server error must not leave the user unable to log
 * out. Failures are logged under `--verbose` and swallowed. Per RFC 7009 §2.2
 * the endpoint also answers 200 for a token it does not recognise, so an
 * already-expired session is indistinguishable from a successful revocation —
 * which is exactly the outcome we want either way.
 */
export async function revokeToken(token: string, tokenTypeHint: TokenTypeHint): Promise<void> {
  const oauth = getOAuthConfig();
  const body = new URLSearchParams({
    token,
    token_type_hint: tokenTypeHint,
    client_id: oauth.clientId,
  });

  try {
    await loggedFetch(oauth.revokeUrl, {
      tag: "oauth",
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      bestEffort: true,
    });
  } catch (error) {
    log.debug(`oauth: token revocation failed — ${errorMessage(error)}`);
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
