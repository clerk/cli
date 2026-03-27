import { generateCodeVerifier, generateCodeChallenge, generateState } from "../../lib/pkce.ts";
import { startAuthServer } from "../../lib/auth-server.ts";
import { exchangeCodeForToken, fetchUserInfo } from "../../lib/token-exchange.ts";
import { getOAuthConfig } from "../../lib/environment.ts";
import { storeToken, getToken } from "../../lib/credential-store.ts";
import { getAuth, setAuth } from "../../lib/config.ts";
import { AUTH_TIMEOUT_MS, CALLBACK_PATH } from "../../lib/constants.ts";

export async function login(): Promise<{ userId: string; email: string }> {
  // Check if already authenticated
  const existingToken = await getToken();
  if (existingToken) {
    const auth = await getAuth();
    if (auth) {
      try {
        const userInfo = await fetchUserInfo(existingToken);
        console.log(`Logged in as ${userInfo.email}`);
        return userInfo;
      } catch {
        // Token expired or invalid — continue with fresh login
      }
    }
  }

  // Generate PKCE parameters
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  // Start local callback server
  const authServer = startAuthServer(state);
  // Use `http://127.0.0.1` (not localhost) so the backend permits any port https://datatracker.ietf.org/doc/html/rfc8252#section-7.3
  const redirectUri = `http://127.0.0.1:${authServer.port}${CALLBACK_PATH}`;

  // Build authorization URL
  const oauth = getOAuthConfig();
  const authorizeUrl = new URL(oauth.authorizeUrl);
  authorizeUrl.searchParams.set("client_id", oauth.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", oauth.scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  // Open browser (platform-aware)
  const openCmd =
    process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
  const proc = Bun.spawn([openCmd, authorizeUrl.toString()]);
  await proc.exited;

  // Wait for the OAuth callback
  const timeoutMinutes = Math.round(AUTH_TIMEOUT_MS / 60_000);
  console.log(`Waiting for authentication (timeout in ${timeoutMinutes}m)...`);
  let callbackResult: { code: string };
  try {
    callbackResult = await authServer.waitForCallback();
  } catch (error) {
    authServer.stop();
    throw error;
  }

  // Exchange authorization code for access token
  const tokenResponse = await exchangeCodeForToken({
    code: callbackResult.code,
    codeVerifier,
    redirectUri,
  });

  // Store the access token
  await storeToken(tokenResponse.access_token);

  // Fetch user info and save to config
  const userInfo = await fetchUserInfo(tokenResponse.access_token);
  await setAuth({ userId: userInfo.userId });

  console.log(`Logged in as ${userInfo.email}`);
  return userInfo;
}
