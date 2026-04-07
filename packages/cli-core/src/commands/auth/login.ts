import type { Need } from "../../lib/deps.ts";
import { throwUserAbort } from "../../lib/errors.ts";
import { AUTH_TIMEOUT_MS, CALLBACK_PATH } from "../../lib/constants.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { cyan, dim } from "../../lib/color.ts";
import type { UserInfo } from "../../lib/token-exchange.ts";

export type LoginDeps = Need<{
  credentialStore: "getToken" | "storeToken";
  configStore: "getAuth" | "setAuth";
  tokenExchange: "exchangeCodeForToken" | "fetchUserInfo";
  authServer: "startAuthServer";
  pkce: "generateCodeVerifier" | "generateCodeChallenge" | "generateState";
  environment: "getOAuthConfig";
  browser: "open";
  prompts: "confirm";
  mode: "isHuman";
  spinner: "intro" | "outro" | "bar" | "withSpinner";
  log: "info";
}>;

interface LoginOptions {
  showNextSteps?: boolean;
}

type GetExistingSessionDeps = Need<{
  credentialStore: "getToken";
  configStore: "getAuth";
  tokenExchange: "fetchUserInfo";
}>;

async function getExistingSession(deps: GetExistingSessionDeps): Promise<UserInfo | null> {
  const token = await deps.credentialStore.getToken();
  if (!token) return null;

  const auth = await deps.configStore.getAuth();
  if (!auth) return null;

  try {
    return await deps.tokenExchange.fetchUserInfo(token);
  } catch {
    return null;
  }
}

type PerformOAuthFlowDeps = Need<{
  credentialStore: "storeToken";
  configStore: "setAuth";
  tokenExchange: "exchangeCodeForToken" | "fetchUserInfo";
  authServer: "startAuthServer";
  pkce: "generateCodeVerifier" | "generateCodeChallenge" | "generateState";
  environment: "getOAuthConfig";
  browser: "open";
  spinner: "withSpinner";
  log: "info";
}>;

async function performOAuthFlow(deps: PerformOAuthFlowDeps): Promise<UserInfo> {
  const codeVerifier = deps.pkce.generateCodeVerifier();
  const codeChallenge = await deps.pkce.generateCodeChallenge(codeVerifier);
  const state = deps.pkce.generateState();

  const authServer = deps.authServer.startAuthServer(state);
  // Use `http://127.0.0.1` (not localhost) so the backend permits any port https://datatracker.ietf.org/doc/html/rfc8252#section-7.3
  const redirectUri = `http://127.0.0.1:${authServer.port}${CALLBACK_PATH}`;

  const oauth = deps.environment.getOAuthConfig();
  const authorizeUrl = new URL(oauth.authorizeUrl);
  authorizeUrl.searchParams.set("client_id", oauth.clientId);
  authorizeUrl.searchParams.set("redirect_uri", redirectUri);
  authorizeUrl.searchParams.set("response_type", "code");
  authorizeUrl.searchParams.set("scope", oauth.scopes);
  authorizeUrl.searchParams.set("state", state);
  authorizeUrl.searchParams.set("code_challenge", codeChallenge);
  authorizeUrl.searchParams.set("code_challenge_method", "S256");

  // Critical fallback: the OAuth callback can't complete unless the user
  // reaches the authorize URL somehow.
  const urlString = authorizeUrl.toString();
  const result = await deps.browser.open(urlString);
  if (!result.ok) {
    deps.log.info(
      `\nCould not open your browser automatically. Open this URL to continue:\n  ${cyan(urlString)}\n${dim("(Reason: " + (result.reason ?? "unknown") + ")")}\n`,
    );
  }

  const timeoutMinutes = Math.round(AUTH_TIMEOUT_MS / 60_000);
  deps.log.info(`Waiting for authentication (timeout in ${timeoutMinutes}m)...`);

  const { code } = await deps.spinner.withSpinner("Waiting for authentication...", () =>
    authServer.waitForCallback().catch((error: unknown) => {
      authServer.stop();
      throw error;
    }),
  );

  const tokenResponse = await deps.spinner.withSpinner("Completing authentication...", () =>
    deps.tokenExchange.exchangeCodeForToken({
      code,
      codeVerifier,
      redirectUri,
    }),
  );

  await deps.credentialStore.storeToken(tokenResponse.access_token);

  const userInfo = await deps.tokenExchange.fetchUserInfo(tokenResponse.access_token);
  await deps.configStore.setAuth({ userId: userInfo.userId });

  return userInfo;
}

export async function login(deps: LoginDeps, options: LoginOptions = {}): Promise<UserInfo> {
  const { showNextSteps = true } = options;
  deps.spinner.intro("clerk login");
  const existingSession = await deps.spinner.withSpinner("Checking session...", () =>
    getExistingSession(deps),
  );

  if (existingSession && !deps.mode.isHuman()) {
    deps.log.info(`Logged in as ${existingSession.email}`);
    return existingSession;
  }

  if (existingSession) {
    const reauthenticate = await deps.prompts.confirm({
      message: `You're already logged in as ${existingSession.email}. Re-authenticate?`,
      default: false,
    });
    if (!reauthenticate) {
      deps.spinner.outro();
      throwUserAbort();
    }
  }

  const userInfo = await performOAuthFlow(deps);

  deps.spinner.bar();
  deps.log.info(`Logged in as ${userInfo.email}`);

  deps.spinner.outro(showNextSteps ? NEXT_STEPS.LOGIN : "Done");
  return userInfo;
}
