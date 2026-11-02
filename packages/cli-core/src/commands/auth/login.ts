import { generateCodeVerifier, generateCodeChallenge, generateState } from "../../lib/pkce.ts";
import { parseCallback, startAuthServer } from "../../lib/auth-server.ts";
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
import { confirm, text } from "../../lib/prompts.ts";
import { isHuman } from "../../mode.ts";
import { ERROR_CODE, errorMessage, throwUserAbort } from "../../lib/errors.ts";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import {
  attemptAutoclaim,
  claimWarning,
  isTemporaryClaimError,
  reportClaimed,
  type AutoclaimResult,
} from "../../lib/autoclaim.ts";
import { openBrowser } from "../../lib/open.ts";
import { cyan, dim } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { currentTelemetryStage, setTelemetryStage } from "../../lib/telemetry.ts";
import { ensureFirstApplication } from "../../lib/first-application.ts";

interface LoginOptions {
  showNextSteps?: boolean;
  yes?: boolean;
  /**
   * `false` skips claiming the folder's keyless app after sign-in. `clerk link` passes it
   * because it claims right after signing in and must see the claim's result itself.
   */
  claim?: boolean;
  /**
   * Compare the folder's publishable keys with the claimed app's before linking it. Only the
   * `clerk auth login` command sets this; `clerk init`, `clerk migrate` and `clerk doctor` sign in
   * through `login()` and must keep linking what they claim.
   */
  checkClaimKeys?: boolean;
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

type AuthServer = ReturnType<typeof startAuthServer>;

/**
 * Wait for the authorization code from whichever channel delivers it first:
 * the loopback redirect, or — when someone is at an interactive terminal — the
 * redirect URL pasted back by hand. The paste path is for machines without a
 * browser: the user signs in on another device, where the redirect to
 * `127.0.0.1` fails to load, and copies that URL from the address bar.
 *
 * Pasting is as safe as the redirect: the URL passes the same state check, and
 * the code is useless without the PKCE verifier, which never leaves this
 * process. Never log the pasted value — it carries the authorization code.
 */
async function awaitAuthorizationCode(authServer: AuthServer, state: string): Promise<string> {
  // No paste prompt for agents, pipes, or CI: there is no one to paste, and
  // they keep the loopback-only behaviour they had before.
  if (!isHuman() || !process.stdin.isTTY) {
    const { code } = await withSpinner("Waiting for authentication...", async () =>
      authServer.waitForCallback().catch((error: unknown) => {
        authServer.stop();
        throw error;
      }),
    );
    return code;
  }

  const prompt = new AbortController();
  const pasted = text({
    message: "Signing in from another device? Paste the URL your browser ended up on",
    placeholder: "http://127.0.0.1:…",
    validate: (value) => checkPastedRedirect(value, state),
    signal: prompt.signal,
  }).then((value) => {
    const outcome = parseCallback(new URL(value.trim()), state);
    // Validation lets an OAuth error through on purpose: a denied consent
    // ends the login, the same as it does on the loopback path.
    if (!outcome.ok) throw outcome.error;
    return outcome.code;
  });

  try {
    // `Promise.race` subscribes to both, so the loser's rejection — the prompt
    // aborted below, or the wait rejected by `stop()` — is handled.
    return await Promise.race([authServer.waitForCallback().then(({ code }) => code), pasted]);
  } finally {
    prompt.abort();
    authServer.stop();
  }
}

/** Prompt validation for a pasted redirect URL; returns a message to re-prompt with. */
function checkPastedRedirect(value: string | undefined, state: string): string | undefined {
  const url = URL.parse(value?.trim() ?? "");
  if (!url) return "Paste the full URL from your browser's address bar.";

  const outcome = parseCallback(url, state);
  if (outcome.ok || outcome.error.code === ERROR_CODE.OAUTH_PROVIDER_ERROR) return undefined;
  if (outcome.error.code === ERROR_CODE.OAUTH_STATE_MISMATCH) {
    return "That URL is from a different sign-in attempt. Use the URL printed above.";
  }
  return "That URL has no authorization code. Paste the full URL from your browser's address bar.";
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
  const code = await awaitAuthorizationCode(authServer, state);

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
  const { showNextSteps = true, yes, claim = true, checkClaimKeys = false } = options;
  intro("Signing in");
  setTelemetryStage("session_check");
  const existingSession = await withSpinner("Checking session...", async () =>
    getExistingSession(),
  );

  if (existingSession && !isHuman()) {
    setTelemetryStage("done");
    log.success(`Logged in as ${existingSession.email}`);
    const claimResult: AutoclaimResult = claim
      ? await handleAutoclaim(process.cwd(), checkClaimKeys)
      : { status: "not_keyless" };
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

  const claimResult: AutoclaimResult = claim
    ? await handleAutoclaim(process.cwd(), checkClaimKeys)
    : { status: "not_keyless" };

  if (showNextSteps) {
    await outro(await loginNextSteps(claimResult));
  } else {
    await outro("Done");
  }

  return userInfo;
}

async function handleAutoclaim(cwd: string, checkKeys: boolean): Promise<AutoclaimResult> {
  const result = await attemptAutoclaim(cwd, { checkKeys });

  if (result.status === "claimed") {
    reportClaimed(result, { unlinkedHint: "Run `clerk link` to finish setup." });
  }

  const warning = claimWarning(result);
  if (warning) log.warn(warning);

  return result;
}

async function loginNextSteps(result: AutoclaimResult): Promise<readonly string[]> {
  if (result.status === "claimed" && !result.linked) return NEXT_STEPS.AUTOCLAIM_MANUAL_LINK;
  if (result.status === "claimed") {
    return result.envPulled ? NEXT_STEPS.AUTOCLAIMED : NEXT_STEPS.AUTOCLAIMED_NO_ENV;
  }
  if (result.status === "failed") {
    return isTemporaryClaimError(result.error)
      ? NEXT_STEPS.AUTOCLAIM_RETRY
      : NEXT_STEPS.AUTOCLAIM_REJECTED;
  }
  if (result.status === "managed_workspace") return NEXT_STEPS.AUTOCLAIM_SWITCH_WORKSPACE;
  if (
    result.status === "not_found" ||
    result.status === "no_organization" ||
    result.status === "keys_mismatch"
  ) {
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
