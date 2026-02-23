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

import { OAUTH } from "./constants.ts";

export const OAUTH_CONFIG = OAUTH;

interface TokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  refresh_token?: string;
}

interface UserInfo {
  userId: string;
  email: string;
}

export async function exchangeCodeForToken(params: {
  code: string;
  codeVerifier: string;
  redirectUri: string;
}): Promise<TokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    client_id: OAUTH_CONFIG.clientId,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
  });

  const response = await fetch(OAUTH_CONFIG.tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Token exchange failed (${response.status}): ${error}`);
  }

  return response.json() as Promise<TokenResponse>;
}

export async function fetchUserInfo(accessToken: string): Promise<UserInfo> {
  const response = await fetch(OAUTH_CONFIG.userinfoUrl, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    const error = await response.text();
    throw new Error(`Failed to fetch user info (${response.status}): ${error}`);
  }

  const data = (await response.json()) as Record<string, unknown>;

  return {
    userId: data.sub as string,
    email: data.email as string,
  };
}
