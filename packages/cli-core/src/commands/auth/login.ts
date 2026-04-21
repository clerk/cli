import { generateCodeVerifier, generateCodeChallenge, generateState } from "../../lib/pkce.ts";
import { startAuthServer } from "../../lib/auth-server.ts";
import { exchangeCodeForToken, fetchUserInfo, type UserInfo } from "../../lib/token-exchange.ts";
import { getOAuthConfig } from "../../lib/environment.ts";
import { storeToken, getToken } from "../../lib/credential-store.ts";
import { getAuth, setAuth, resolveProfile } from "../../lib/config.ts";
import { AUTH_TIMEOUT_MS, CALLBACK_PATH } from "../../lib/constants.ts";
import { confirm } from "../../lib/prompts.ts";
import { isHuman } from "../../mode.ts";
import { throwUserAbort } from "../../lib/errors.ts";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { attemptAutoclaim, type AutoclaimResult } from "../../lib/autoclaim.ts";
import { openBrowser } from "../../lib/open.ts";
import { cyan, dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";

interface LoginOptions {
  showNextSteps?: boolean;
}

async function getExistingSession(): Promise<UserInfo | null> {
  const token = await getToken();
  if (!token) return null;

  const auth = await getAuth();
  if (!auth) return null;

  try {
    return await fetchUserInfo(token);
  } catch {
    return null;
  }
}

async function performOAuthFlow(): Promise<UserInfo> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = await generateCodeChallenge(codeVerifier);
  const state = generateState();

  const authServer = startAuthServer(state);
  // Use `http://127.0.0.1` (not localhost) so the backend permits any port https://datatracker.ietf.org/doc/html/rfc8252#section-7.3
  const redirectUri = `http://127.0.0.1:${authServer.port}${CALLBACK_PATH}`;

  const oauth = getOAuthConfig();
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
  const result = await openBrowser(urlString);
  if (!result.ok) {
    log.warn(
      `\nCould not open your browser automatically. Open this URL to continue:\n  ${cyan(urlString)}\n${dim("(Reason: " + result.reason + ")")}\n`,
    );
  }

  const timeoutMinutes = Math.round(AUTH_TIMEOUT_MS / 60_000);
  log.info(`Waiting for authentication (timeout in ${timeoutMinutes}m)...`);

  const { code } = await withSpinner("Waiting for authentication...", () =>
    authServer.waitForCallback().catch((error: unknown) => {
      authServer.stop();
      throw error;
    }),
  );

  const tokenResponse = await withSpinner("Completing authentication...", () =>
    exchangeCodeForToken({
      code,
      codeVerifier,
      redirectUri,
    }),
  );

  await storeToken(tokenResponse.access_token);

  const userInfo = await fetchUserInfo(tokenResponse.access_token);
  await setAuth({ userId: userInfo.userId });

  return userInfo;
}

export async function login(options: LoginOptions = {}): Promise<UserInfo> {
  const { showNextSteps = true } = options;
  intro("clerk auth login");
  const existingSession = await withSpinner("Checking session...", () => getExistingSession());

  if (existingSession && !isHuman()) {
    log.success(`Logged in as ${existingSession.email}`);
    const claimResult = await handleAutoclaim(process.cwd());
    if (showNextSteps) {
      outro(await loginNextSteps(claimResult));
    } else {
      outro("Done");
    }
    return existingSession;
  }

  if (existingSession) {
    const reauthenticate = await confirm({
      message: `You're already logged in as ${existingSession.email}. Re-authenticate?`,
      default: false,
    });
    if (!reauthenticate) {
      outro();
      throwUserAbort();
    }
  }

  const userInfo = await performOAuthFlow();

  bar();
  log.success(`Logged in as ${userInfo.email}`);

  const claimResult = await handleAutoclaim(process.cwd());

  if (showNextSteps) {
    outro(await loginNextSteps(claimResult));
  } else {
    outro("Done");
  }

  return userInfo;
}

const CLAIM_WARNINGS: Partial<Record<AutoclaimResult["status"], string>> = {
  not_found:
    "Claim token is no longer valid - the application may have been claimed from the dashboard.",
  no_organization: "Unable to claim - your account does not have an active organization.",
  failed: "Auto-claim failed due to a temporary error. It will be retried on your next login.",
};

async function handleAutoclaim(cwd: string): Promise<AutoclaimResult> {
  const result = await attemptAutoclaim(cwd);

  if (result.status === "claimed") {
    const label = result.app.name || result.app.application_id;
    log.success(`Claimed and linked application: \`${label}\``);
  }

  const warning = CLAIM_WARNINGS[result.status];
  if (warning) log.warn(warning);

  return result;
}

async function loginNextSteps(result: AutoclaimResult): Promise<readonly string[]> {
  if (result.status === "claimed") {
    return result.envPulled ? NEXT_STEPS.AUTOCLAIMED : NEXT_STEPS.AUTOCLAIMED_NO_ENV;
  }
  if (result.status === "failed") return NEXT_STEPS.AUTOCLAIM_RETRY;
  if (result.status === "not_found" || result.status === "no_organization") {
    return NEXT_STEPS.AUTOCLAIM_MANUAL_LINK;
  }

  const linked = await resolveProfile(process.cwd());
  if (!linked) return NEXT_STEPS.LOGIN;

  const appLabel = linked.profile.appName
    ? `\`${linked.profile.appName}\` (${linked.profile.appId})`
    : `\`${linked.profile.appId}\``;
  log.success(`Linked to ${appLabel}`);
  return NEXT_STEPS.LOGIN_LINKED;
}
