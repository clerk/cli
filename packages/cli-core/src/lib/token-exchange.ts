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

import type { Environment } from "./environment.ts";
import { ApiError, withApiContext } from "./errors.ts";

export interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

export interface UserInfo {
  userId: string;
  email: string;
}

export interface TokenExchange {
  exchangeCodeForToken(params: {
    code: string;
    codeVerifier: string;
    redirectUri: string;
  }): Promise<TokenResponse>;
  fetchUserInfo(accessToken: string): Promise<UserInfo>;
}

export function createTokenExchange(env: Environment): TokenExchange {
  return {
    async exchangeCodeForToken(params: {
      code: string;
      codeVerifier: string;
      redirectUri: string;
    }): Promise<TokenResponse> {
      const oauth = env.getOAuthConfig();
      const body = new URLSearchParams({
        grant_type: "authorization_code",
        code: params.code,
        client_id: oauth.clientId,
        code_verifier: params.codeVerifier,
        redirect_uri: params.redirectUri,
      });

      return withApiContext(
        (async () => {
          const response = await fetch(oauth.tokenUrl, {
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
    },

    async fetchUserInfo(accessToken: string): Promise<UserInfo> {
      const oauth = env.getOAuthConfig();
      return withApiContext(
        (async () => {
          const response = await fetch(oauth.userinfoUrl, {
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
    },
  };
}
