/**
 * A person's `clerk auth login` asks before it claims the app `clerk init`
 * created, and the question names where the claim will put it.
 *
 * Separate from `login.test.ts` to keep that file under 50 KB: Bun caches the
 * transpiled form of larger files, and on a cache hit under Bun 1.3.14 the
 * version macro in `lib/version.ts` comes back undefined, so every run after
 * the first fails before any test starts.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { UserAbortError } from "../../lib/errors.ts";
import { configStubs, credentialStoreStubs, useCaptureLog } from "../../test/lib/stubs.ts";
import type { AutoclaimResult } from "../../lib/autoclaim.ts";

const actualEnvironment = await import("../../lib/environment.ts");
const { parseCallback } = await import("../../lib/auth-server.ts");

const mockGetValidToken = mock();
const mockGetAuth = mock();
const mockFetchUserInfo = mock();
const mockStartAuthServer = mock();
const mockIsHuman = mock();
const mockConfirm = mock();
/** The folder's init token as login reads it once, at the start. */
type InitClaim = { appName: string; claimToken: string };
const INIT_CLAIM: InitClaim = { appName: "my-app", claimToken: "claim_token_asked_about" };

const mockAttemptAutoclaim = mock(
  async (_cwd: string, _init?: InitClaim): Promise<AutoclaimResult> => ({ status: "not_found" }),
);
const mockReadInitClaim = mock(async (_cwd: string): Promise<InitClaim | undefined> => undefined);

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
  storeToken: async () => {},
  createOAuthSession: () => ({
    accessToken: "new-access-token",
    refreshToken: "new-refresh-token",
    expiresAt: 123,
    tokenType: "Bearer",
  }),
  getStoredSession: async () => null,
}));

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  getAuth: (...args: unknown[]) => mockGetAuth(...args),
  setAuth: async () => {},
  resolveProfile: async () => undefined,
}));

mock.module("../../lib/token-exchange.ts", () => ({
  exchangeCodeForToken: async () => ({
    access_token: "new-access-token",
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "new-refresh-token",
  }),
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
  revokeToken: async () => "revoked",
}));

mock.module("../../lib/environment.ts", () => ({
  ...actualEnvironment,
  getOAuthConfig: () => ({
    clientId: "test-client-id",
    scopes: "profile email",
    authorizeUrl: "https://test.example.com/oauth/authorize",
    tokenUrl: "https://test.example.com/oauth/token",
    userinfoUrl: "https://test.example.com/oauth/userinfo",
  }),
}));

mock.module("../../lib/pkce.ts", () => ({
  generateCodeVerifier: () => "test-code-verifier",
  generateCodeChallenge: () => "test-code-challenge",
  generateState: () => "test-state-value",
}));

mock.module("../../lib/auth-server.ts", () => ({
  startAuthServer: (...args: unknown[]) => mockStartAuthServer(...args),
  parseCallback,
}));

mock.module("../../mode.ts", () => ({
  isHuman: (...args: unknown[]) => mockIsHuman(...args),
  isAgent: () => !mockIsHuman(),
  getMode: () => (mockIsHuman() ? "human" : "agent"),
  setMode: () => {},
}));

mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: async () => "",
  password: async () => "",
  editor: async () => "",
}));

mock.module("../../lib/open.ts", () => ({
  openBrowser: async () => ({ ok: true, launcher: "test" }),
}));

mock.module("../../lib/first-application.ts", () => ({
  ensureFirstApplication: async () => {},
}));

mock.module("../../lib/autoclaim.ts", () => ({
  attemptAutoclaim: (cwd: string, init?: InitClaim) => mockAttemptAutoclaim(cwd, init),
  readInitClaim: (cwd: string) => mockReadInitClaim(cwd),
}));

const { login } = await import("./login.ts");

const captured = useCaptureLog();
const origStdinIsTTY = process.stdin.isTTY;

beforeEach(() => {
  // The paste-back prompt only appears on an interactive stdin; pin it off so
  // the only questions are the ones under test.
  process.stdin.isTTY = false;
});

afterEach(() => {
  for (const m of [
    mockGetValidToken,
    mockGetAuth,
    mockFetchUserInfo,
    mockStartAuthServer,
    mockIsHuman,
    mockConfirm,
    mockAttemptAutoclaim,
    mockReadInitClaim,
  ]) {
    m.mockReset();
  }
  process.stdin.isTTY = origStdinIsTTY;
});

function runLogin(options?: Parameters<typeof login>[0]) {
  return login(options);
}

/** A browser sign-in that completes at once and signs `user` in. */
function mockOAuthSuccess({ user }: { user: { userId: string; email: string } }) {
  mockStartAuthServer.mockReturnValue({
    port: 54321,
    waitForCallback: mock().mockResolvedValue({ code: "fresh-auth-code" }),
    stop: mock(),
  });
  mockFetchUserInfo.mockResolvedValue(user);
}

// A person is asked before any claim, and the question names where the app
// will go. CLERK_PLATFORM_API_KEY decides that for every Platform API call
// whenever it's set, so each test names its credentials: a stored session,
// the API key, both, or neither.
describe("a person is asked before the app `clerk init` created is claimed", () => {
  const API_KEY = "ak_test_platform_key";
  const savedApiKey = process.env.CLERK_PLATFORM_API_KEY;

  const askAccount = (email: string) =>
    `Claim \`my-app\` (the app \`clerk init\` created in this folder) into ${email}'s account?`;
  const OFFER_SOMEONE_ELSE = " No signs you in as someone else first.";
  const ASK_API_KEY =
    "Claim `my-app` (the app `clerk init` created in this folder) into the workspace your `CLERK_PLATFORM_API_KEY` belongs to?";
  const STILL_UNCLAIMED =
    "Skipped the claim, so `my-app` is still unclaimed. Its claim token stays in this folder.";
  // Printed with `log.info`, which colors backticked words: compare it uncolored.
  const keyDecides = (email: string) =>
    "Claims go to the workspace your `CLERK_PLATFORM_API_KEY` belongs to while it's set. " +
    `Unset it to claim \`my-app\` into ${email}'s account instead.`;
  const CLAIM_LATER = "Run `clerk auth login` again to claim `my-app`";

  const EXISTING_USER = { userId: "user_existing", email: "jane@example.com" };
  const NEW_USER = { userId: "user_new", email: "new@example.com" };

  beforeEach(() => {
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockReadInitClaim.mockResolvedValue(INIT_CLAIM);
    mockAttemptAutoclaim.mockResolvedValue({
      status: "claimed",
      app: { application_id: "app_init", name: "my-app", instances: [] },
      local: { kind: "linked", envPulled: true },
    });
  });

  afterEach(() => {
    if (savedApiKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
    else process.env.CLERK_PLATFORM_API_KEY = savedApiKey;
  });

  /** A stored session for jane@example.com; a later browser sign-in returns NEW_USER. */
  function storedSession() {
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: EXISTING_USER.userId });
    mockFetchUserInfo.mockResolvedValueOnce(EXISTING_USER);
    mockOAuthSuccess({ user: NEW_USER });
  }

  function noStoredSession() {
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess({ user: NEW_USER });
  }

  /**
   * Queues the person's answers. Returns, per question, whether the browser
   * sign-in had already started when it was asked.
   */
  function answer(...answers: boolean[]): boolean[] {
    const browserStartedWhenAsked: boolean[] = [];
    for (const reply of answers) {
      mockConfirm.mockImplementationOnce(async () => {
        browserStartedWhenAsked.push(mockStartAuthServer.mock.calls.length > 0);
        return reply;
      });
    }
    return browserStartedWhenAsked;
  }

  function questions() {
    return mockConfirm.mock.calls.map(([config]) => config);
  }

  test("stored session only: asks in place of re-authenticating, and Yes claims with the current session", async () => {
    mockIsHuman.mockReturnValue(true);
    storedSession();
    answer(true);

    const result = await runLogin();

    expect(questions()).toEqual([
      { message: askAccount("jane@example.com") + OFFER_SOMEONE_ELSE, default: true },
    ]);
    expect(mockStartAuthServer).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(result).toEqual(EXISTING_USER);
    expect(captured.err).toContain("Claimed and linked application: `my-app`");
  });

  test("stored session only, No then Yes: signs in again, then asks again naming the new account", async () => {
    mockIsHuman.mockReturnValue(true);
    storedSession();
    answer(false, true);

    const result = await runLogin();

    expect(questions()).toEqual([
      { message: askAccount("jane@example.com") + OFFER_SOMEONE_ELSE, default: true },
      { message: askAccount("new@example.com"), default: true },
    ]);
    expect(mockStartAuthServer).toHaveBeenCalledTimes(1);
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(result).toEqual(NEW_USER);
  });

  test("stored session only, No then No: the new sign-in stands, and the app is still unclaimed", async () => {
    mockIsHuman.mockReturnValue(true);
    storedSession();
    answer(false, false);

    const result = await runLogin();

    expect(mockConfirm).toHaveBeenCalledTimes(2);
    expect(mockStartAuthServer).toHaveBeenCalledTimes(1);
    // The claim routine is what removes the token, so it stays on disk.
    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
    expect(result).toEqual(NEW_USER);
    expect(captured.err).toContain(STILL_UNCLAIMED);
    expect(captured.err).toContain(CLAIM_LATER);
  });

  test("stored session and API key: names the key's workspace, offers no other sign-in, and No ends without claiming", async () => {
    process.env.CLERK_PLATFORM_API_KEY = API_KEY;
    mockIsHuman.mockReturnValue(true);
    storedSession();
    answer(false);

    await expect(runLogin()).rejects.toBeInstanceOf(UserAbortError);

    expect(questions()).toEqual([{ message: ASK_API_KEY, default: true }]);
    expect(mockStartAuthServer).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
    expect(captured.err).toContain(STILL_UNCLAIMED);
    expect(Bun.stripANSI(captured.err)).toContain(keyDecides("jane@example.com"));
  });

  test("stored session and API key, Yes: claims without signing in again", async () => {
    process.env.CLERK_PLATFORM_API_KEY = API_KEY;
    mockIsHuman.mockReturnValue(true);
    storedSession();
    answer(true);

    const result = await runLogin();

    expect(questions()).toEqual([{ message: ASK_API_KEY, default: true }]);
    expect(mockStartAuthServer).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(result).toEqual(EXISTING_USER);
  });

  test("API key only: asks before any browser step, and Yes claims with the key and no sign-in", async () => {
    process.env.CLERK_PLATFORM_API_KEY = API_KEY;
    mockIsHuman.mockReturnValue(true);
    noStoredSession();
    answer(true);

    const result = await runLogin();

    expect(questions()).toEqual([{ message: ASK_API_KEY, default: true }]);
    expect(mockStartAuthServer).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
    expect(captured.err).toContain("Claimed and linked application: `my-app`");
  });

  test("API key only, No: signs in without claiming, and says the key decides where claims go", async () => {
    process.env.CLERK_PLATFORM_API_KEY = API_KEY;
    mockIsHuman.mockReturnValue(true);
    noStoredSession();
    const browserStartedWhenAsked = answer(false);

    const result = await runLogin();

    expect(browserStartedWhenAsked).toEqual([false]);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockStartAuthServer).toHaveBeenCalledTimes(1);
    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
    expect(result).toEqual(NEW_USER);
    expect(captured.err).toContain(STILL_UNCLAIMED);
    expect(Bun.stripANSI(captured.err)).toContain(keyDecides("new@example.com"));
    expect(captured.err).toContain(CLAIM_LATER);
  });

  test("signed out: asks after the browser sign-in, naming the account just signed into, and Yes claims", async () => {
    mockIsHuman.mockReturnValue(true);
    noStoredSession();
    const browserStartedWhenAsked = answer(true);

    const result = await runLogin();

    expect(browserStartedWhenAsked).toEqual([true]);
    expect(questions()).toEqual([{ message: askAccount("new@example.com"), default: true }]);
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(result).toEqual(NEW_USER);
  });

  test("signed out, No: the sign-in stands, and the app is still unclaimed", async () => {
    mockIsHuman.mockReturnValue(true);
    noStoredSession();
    answer(false);

    const result = await runLogin();

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
    expect(result).toEqual(NEW_USER);
    expect(captured.err).toContain(STILL_UNCLAIMED);
    expect(captured.err).toContain(CLAIM_LATER);
    expect(captured.err).not.toContain("CLERK_PLATFORM_API_KEY");
  });

  test("-y signs in again and then claims, without asking", async () => {
    mockIsHuman.mockReturnValue(true);
    storedSession();
    let browserStartedBeforeClaim = false;
    mockAttemptAutoclaim.mockImplementation(async () => {
      browserStartedBeforeClaim = mockStartAuthServer.mock.calls.length > 0;
      return { status: "not_found" };
    });

    await runLogin({ yes: true });

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(browserStartedBeforeClaim).toBe(true);
  });

  test.each([
    { credentials: "a stored session only", apiKey: false, session: true },
    { credentials: "a stored session and an API key", apiKey: true, session: true },
    { credentials: "an API key only", apiKey: true, session: false },
    { credentials: "no credentials", apiKey: false, session: false },
  ])("agent mode with $credentials claims without asking", async ({ apiKey, session }) => {
    if (apiKey) process.env.CLERK_PLATFORM_API_KEY = API_KEY;
    mockIsHuman.mockReturnValue(false);
    if (session) storedSession();
    else noStoredSession();

    await runLogin();

    expect(mockConfirm).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
  });

  // `init`, `migrate`, and `link` sign in on their way to `link()`, which
  // applies the claim policy itself.
  test.each([
    { who: "a signed-out person", human: true, session: false },
    { who: "a signed-in agent", human: false, session: true },
  ])(
    "claim: false lets $who sign in without the question or the claim",
    async ({ human, session }) => {
      mockIsHuman.mockReturnValue(human);
      if (session) storedSession();
      else noStoredSession();

      await runLogin({ showNextSteps: false, claim: false });

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
      // Reads nothing, so a malformed token file isn't warned about or deleted.
      expect(mockReadInitClaim).not.toHaveBeenCalled();
    },
  );

  // The token is read once, at the start, and the claim redeems exactly that
  // one: a token that replaces it while the question is open, or appears during
  // the browser sign-in, waits for the next run.
  test.each([
    { who: "a person who answers Yes", human: true },
    { who: "an agent", human: false },
  ])("$who: the claim redeems the token read at the start", async ({ human }) => {
    mockIsHuman.mockReturnValue(human);
    storedSession();
    if (human) answer(true);

    await runLogin();

    expect(mockReadInitClaim).toHaveBeenCalledTimes(1);
    expect(mockAttemptAutoclaim).toHaveBeenCalledWith(expect.any(String), INIT_CLAIM);
  });

  /** A stored session that can no longer be refreshed, which login treats as signed out. */
  function expiredSession() {
    mockGetAuth.mockResolvedValue({ userId: EXISTING_USER.userId });
    mockGetValidToken.mockRejectedValue(new Error("Your session has expired."));
    mockOAuthSuccess({ user: NEW_USER });
  }

  test("expired session, no API key: asks after the browser sign-in, naming the account just signed into", async () => {
    mockIsHuman.mockReturnValue(true);
    expiredSession();
    const browserStartedWhenAsked = answer(true);

    const result = await runLogin();

    expect(browserStartedWhenAsked).toEqual([true]);
    expect(questions()).toEqual([{ message: askAccount("new@example.com"), default: true }]);
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(result).toEqual(NEW_USER);
  });

  test("expired session and API key: asks before any browser step, and Yes claims with no sign-in", async () => {
    process.env.CLERK_PLATFORM_API_KEY = API_KEY;
    mockIsHuman.mockReturnValue(true);
    expiredSession();
    answer(true);

    const result = await runLogin();

    expect(questions()).toEqual([{ message: ASK_API_KEY, default: true }]);
    expect(mockStartAuthServer).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(result).toBeUndefined();
  });

  // Nothing checks that Clerk's account-info reply has an email. Whether to ask
  // depends on whether a session exists; the email only shapes the wording.
  const NO_EMAIL_USER = { userId: "user_no_email" } as unknown as typeof EXISTING_USER;
  const ASK_SIGNED_IN_ACCOUNT =
    "Claim `my-app` (the app `clerk init` created in this folder) into the account you're signed in to?";

  test("a stored session with no email is still asked about first, naming the signed-in account", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue("existing-token");
    mockGetAuth.mockResolvedValue({ userId: NO_EMAIL_USER.userId });
    mockFetchUserInfo.mockResolvedValueOnce(NO_EMAIL_USER);
    mockOAuthSuccess({ user: NEW_USER });
    answer(true);

    await runLogin();

    expect(questions()).toEqual([
      { message: ASK_SIGNED_IN_ACCOUNT + OFFER_SOMEONE_ELSE, default: true },
    ]);
    expect(mockStartAuthServer).not.toHaveBeenCalled();
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expect(captured.err).not.toContain("undefined");
  });

  test("a sign-in with no email asks about the signed-in account and never prints undefined", async () => {
    mockIsHuman.mockReturnValue(true);
    mockGetValidToken.mockResolvedValue(null);
    mockOAuthSuccess({ user: NO_EMAIL_USER });
    answer(false);

    await runLogin();

    expect(questions()).toEqual([{ message: ASK_SIGNED_IN_ACCOUNT, default: true }]);
    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
    expect(captured.err).toContain(STILL_UNCLAIMED);
    expect(captured.err).not.toContain("undefined");
  });
});
