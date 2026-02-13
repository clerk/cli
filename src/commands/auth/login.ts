import { generateCodeVerifier, generateCodeChallenge, generateState } from "../../lib/pkce.ts";
import { startAuthServer } from "../../lib/auth-server.ts";
import { OAUTH_CONFIG, exchangeCodeForToken, fetchUserInfo } from "../../lib/token-exchange.ts";
import { storeToken, getToken } from "../../lib/credential-store.ts";
import { getAuth, setAuth } from "../../lib/config.ts";

export async function login(): Promise<{ userId: string; email: string }> {
  // Check if already authenticated
  const existingToken = await getToken();
  if (existingToken) {
    const auth = await getAuth();
    if (auth) {
      try {
        const userInfo = await fetchUserInfo(existingToken);
        console.log(`Already logged in as ${userInfo.email}`);
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
  const redirectUri = `http://127.0.0.1:${authServer.port}/callback`;

  // Build authorization URL
  const authorizeUrl = new URL(OAUTH_CONFIG.authorizeUrl);
  authorizeUrl.searchParams.set("client_id", OAUTH_CONFIG.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", OAUTH_CONFIG.scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  // Open browser
  const proc = Bun.spawn(["open", authorizeUrl.toString()]);
  await proc.exited;

  // Wait for the OAuth callback
  console.log("Waiting for authentication...");
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
