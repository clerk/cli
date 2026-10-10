import { generateCodeVerifier, generateCodeChallenge, generateState } from "../../lib/pkce.ts";
import { startAuthServer } from "../../lib/auth-server.ts";
import {
  exchangeCodeForToken,
  fetchUserInfo,
  revokeToken,
  type UserInfo,
} from "../../lib/token-exchange.ts";
import { getOAuthConfig } from "../../lib/environment.ts";
import {
  createOAuthSession,
  getStoredSession,
  getValidToken,
  storeToken,
  type OAuthSession,
} from "../../lib/credential-store.ts";
import { getAuth, setAuth, resolveProfile } from "../../lib/config.ts";
import { AUTH_TIMEOUT_MS, CALLBACK_PATH, CLERK_CLIENT_CLI } from "../../lib/constants.ts";
import { confirm } from "../../lib/prompts.ts";
import { isHuman } from "../../mode.ts";
import { errorMessage, throwUserAbort } from "../../lib/errors.ts";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { attemptAutoclaim, type AutoclaimResult } from "../../lib/autoclaim.ts";
import { openBrowser } from "../../lib/open.ts";
import { cyan, dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { currentTelemetryStage, setTelemetryStage } from "../../lib/telemetry.ts";
import { ensureFirstApplication } from "../../lib/first-application.ts";

interface LoginOptions {
  showNextSteps?: boolean;
  yes?: boolean;
}

async function getExistingSession(): Promise<UserInfo | null> {
  const auth = await getAuth();
  if (!auth) return null;

  try {
    const token = await getValidToken();
    if (!token) return null;
    return await fetchUserInfo(token);
  } catch {
    return null;
  }
}

interface OAuthFlowResult {
  userInfo: UserInfo;
  /**
   * The session that was current immediately before the token exchange
   * replaced it, or null if there was none. The caller revokes it.
   */
  previousSession: OAuthSession | null;
}

async function performOAuthFlow(): Promise<OAuthFlowResult> {
  const codeVerifier = generateCodeVerifier();
  const codeChallenge = generateCodeChallenge(codeVerifier);
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
  authorizeUrl.searchParams.set("clerk_client", CLERK_CLIENT_CLI);

  // Printed unconditionally: a launcher can exit 0 without anything visibly
  // opening (WSL, headless shells), and the flow can't complete unless the
  // user reaches this URL. Safe to display — the token exchange also requires
  // the PKCE code verifier, which never leaves this process.
  const urlString = authorizeUrl.toString();
  log.info(
    `Opening your browser to sign in. If it doesn't open, use this URL:\n  ${cyan(urlString)}`,
  );
  const result = await openBrowser(urlString);
  if (!result.ok) {
    log.warn(
      `Could not open your browser automatically ${dim(`(${result.reason})`)}. Open the URL above to continue.`,
    );
  }

  const timeoutMinutes = Math.round(AUTH_TIMEOUT_MS / 60_000);
  log.info(`Waiting for authentication (timeout in ${timeoutMinutes}m)...`);

  setTelemetryStage("awaiting_callback");
  const { code } = await withSpinner("Waiting for authentication...", async () =>
    authServer.waitForCallback().catch((error: unknown) => {
      authServer.stop();
      throw error;
    }),
  );

  // Snapshotted here: the authorization code has arrived, so the store still
  // holds the outgoing session and is about to be overwritten. Reading any
  // earlier widens the window for another process to rotate the refresh token
  // out from under the revocation; reading any later returns the session we
  // just created and would revoke the grant we are in the middle of minting.
  let previousSession: OAuthSession | null = null;
  try {
    previousSession = await getStoredSession();
  } catch (error) {
    // An unreadable store must not fail an otherwise successful login; we just
    // lose the ability to revoke whatever was there.
    log.debug(`credentials: could not read outgoing session — ${errorMessage(error)}`);
  }

  setTelemetryStage("token_exchange");
  const tokenResponse = await withSpinner("Completing authentication...", async () =>
    exchangeCodeForToken({
      code,
      codeVerifier,
      redirectUri,
    }),
  );

  setTelemetryStage("store");
  await storeToken(createOAuthSession(tokenResponse));

  const userInfo = await fetchUserInfo(tokenResponse.access_token);
  await setAuth({ userId: userInfo.userId });

  return { userInfo, previousSession };
}

export async function login(options: LoginOptions = {}): Promise<UserInfo> {
  // `init` and `link` call this mid-flow and share the one process-global
  // telemetry stage. Login's own markers are worth having while it runs, but
  // on a clean return the caller's stage comes back so the rest of *their*
  // work isn't reported as `done`. On a throw the login stage stands: that is
  // genuinely where the run stopped.
  const callerStage = currentTelemetryStage();
  const userInfo = await runLogin(options);
  if (callerStage) setTelemetryStage(callerStage);
  return userInfo;
}

async function runLogin(options: LoginOptions = {}): Promise<UserInfo> {
  const { showNextSteps = true, yes } = options;
  intro("Signing in");
  setTelemetryStage("session_check");
  const existingSession = await withSpinner("Checking session...", async () =>
    getExistingSession(),
  );

  if (existingSession && !isHuman()) {
    setTelemetryStage("done");
    log.success(`Logged in as ${existingSession.email}`);
    const claimResult = await handleAutoclaim(process.cwd());
    if (showNextSteps) {
      await outro(await loginNextSteps(claimResult));
    } else {
      await outro("Done");
    }
    return existingSession;
  }

  if (existingSession && isHuman() && !yes) {
    const reauthenticate = await confirm({
      message: `You're already logged in as ${existingSession.email}. Re-authenticate?`,
      default: false,
    });
    if (!reauthenticate) {
      await outro();
      throwUserAbort();
    }
  }

  // `previousSession` comes from the credential store, not from
  // `existingSession`: the latter is the result of a network round trip whose
  // errors are all swallowed, so a transient failure there would silently
  // orphan a live grant instead of revoking it. The store is the authority on
  // whether there is anything to revoke.
  const { userInfo, previousSession } = await performOAuthFlow();

  // Revoked only after the replacement is safely stored: doing it up front
  // would leave the user with no session at all if the flow were abandoned.
  if (previousSession) {
    const outcome = await withSpinner("Revoking previous session...", async () =>
      revokeToken(previousSession.refreshToken, "refresh_token"),
    );
    if (outcome === "failed") {
      log.warn(
        "Signed in, but the previous session could not be revoked with Clerk. Revoke it from the dashboard if it may have been exposed.",
      );
    }
  }

  // Best-effort: ensure the user has at least one application so downstream
  // commands (clerk link, clerk init) have something to operate on.
  setTelemetryStage("first_application");
  await withSpinner("Setting up your default application...", async () => ensureFirstApplication());

  bar();
  setTelemetryStage("done");
  log.success(`Logged in as ${userInfo.email}`);

  const claimResult = await handleAutoclaim(process.cwd());

  if (showNextSteps) {
    await outro(await loginNextSteps(claimResult));
  } else {
    await outro("Done");
  }

  return userInfo;
}

const CLAIM_WARNINGS: Partial<Record<AutoclaimResult["status"], string>> = {
  not_found:
    "Claim token is no longer valid - the application may have been claimed from the dashboard.",
  no_organization: "Unable to claim - your account does not have an active organization.",
  failed:
    "Auto-claim failed due to a temporary error. It will be retried on your next `clerk auth login`.",
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
