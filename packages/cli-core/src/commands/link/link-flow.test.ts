/**
 * `clerk link`'s decisions about which app a folder runs on: matching the key
 * the app loads, and refusing to guess when it can't tell.
 *
 * Separate from `index.test.ts` to keep each file under 50 KB: Bun caches the
 * transpiled form of larger files, and under Bun 1.3.14 a cache hit breaks the
 * version macro when tests run from `packages/cli-core`.
 */

import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  autolinkStubs,
  configStubs,
  credentialStoreStubs,
  gitStubs,
  listageStubs,
  useCaptureLog,
} from "../../test/lib/stubs.ts";
import { UserAbortError } from "../../lib/errors.ts";

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => (mockIsAgent() ? "agent" : "human"),
}));

const mockGetToken = mock();
mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: (...args: unknown[]) => mockGetToken(...args),
  getValidToken: (...args: unknown[]) => mockGetToken(...args),
}));

const mockFetchUserInfo = mock();
mock.module("../../lib/token-exchange.ts", () => ({
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
  exchangeCodeForToken: async () => ({}),
  revokeToken: async () => "revoked",
}));

/** The folder's init token, as `clerk link` reads it once. */
type InitClaim = { appName: string; claimToken: string };
const mockReadInitClaim = mock(async (_cwd: string): Promise<InitClaim | undefined> => undefined);
const mockAttemptAutoclaim = mock();
mock.module("../../lib/autoclaim.ts", () => ({
  readInitClaim: (cwd: string) => mockReadInitClaim(cwd),
  attemptAutoclaim: (...args: unknown[]) => mockAttemptAutoclaim(...args),
}));

const mockLogin = mock();
mock.module("../auth/login.ts", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

const mockListApplications = mock();
const mockFetchApplication = mock();
const mockCreateApplication = mock();
mock.module("../../lib/plapi.ts", () => ({
  listApplications: (...args: unknown[]) => mockListApplications(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  createApplication: (...args: unknown[]) => mockCreateApplication(...args),
  PlapiError: class PlapiError extends Error {},
  fetchInstanceConfig: async () => ({}),
  putInstanceConfig: async () => ({}),
  patchInstanceConfig: async () => ({}),
}));

const mockSetProfile = mock();
const mockResolveProfile = mock(async (): Promise<unknown> => undefined);
const mockGetAuth = mock();
mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  setProfile: (...args: unknown[]) => mockSetProfile(...args),
  resolveProfile: () => mockResolveProfile(),
  getAuth: () => mockGetAuth(),
}));

const mockAutolink = mock(async (_cwd: string): Promise<unknown> => ({ status: "no_key" }));
mock.module("../../lib/autolink.ts", () => ({
  ...autolinkStubs,
  autolink: (cwd: string) => mockAutolink(cwd),
}));

mock.module("../../lib/git.ts", () => ({
  ...gitStubs,
  getGitRepoIdentifier: async () => "/repo/.git",
  getGitRepoRoot: async () => "/repo",
  getGitNormalizedRemote: async () => "github.com/org/repo",
}));

const mockConfirm = mock();
mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: async () => "",
  password: async () => "",
  editor: async () => "",
}));

const mockSearch = mock();
mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  search: (...args: unknown[]) => mockSearch(...args),
}));

// No test may reach a real browser: tests where nothing should open would
// launch one if a bug called it.
const mockOpenBrowser = mock(async (_url: string) => ({ ok: true, launcher: "test" }));
mock.module("../../lib/open.ts", () => ({
  openBrowser: (url: string) => mockOpenBrowser(url),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: async () => {},
  pausedOutro: () => {},
  bar: () => {},
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { link } = await import("./index.ts");

useCaptureLog();

const savedApiKey = process.env.CLERK_PLATFORM_API_KEY;

beforeEach(() => {
  delete process.env.CLERK_PLATFORM_API_KEY;
});

afterEach(() => {
  if (savedApiKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = savedApiKey;
  for (const m of [
    mockIsAgent,
    mockGetToken,
    mockFetchUserInfo,
    mockGetAuth,
    mockAttemptAutoclaim,
    mockLogin,
    mockListApplications,
    mockFetchApplication,
    mockCreateApplication,
    mockSetProfile,
    mockAutolink,
    mockConfirm,
    mockSearch,
    mockOpenBrowser,
  ]) {
    m.mockReset();
  }
  mockResolveProfile.mockReset();
  mockResolveProfile.mockResolvedValue(undefined);
  mockReadInitClaim.mockReset();
  mockReadInitClaim.mockResolvedValue(undefined);
  mockAutolink.mockResolvedValue({ status: "no_key" });
  mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "test" });
});

const UNDECIDED =
  "`.env.local` and `.env` hold different Clerk publishable keys, and the CLI doesn't know which one this app loads";

describe("couldn't tell which key the folder's app loads", () => {
  // `clerk init` would write the new app's keys over ones the CLI couldn't
  // attribute to any app.
  test("an agent never creates an app for the folder, even when asked to create one if missing", async () => {
    mockIsAgent.mockReturnValue(true);
    mockGetToken.mockResolvedValue("token");
    mockAutolink.mockResolvedValue({ status: "couldnt_tell", reason: UNDECIDED });
    const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await expect(link({ skipIfLinked: true, createIfMissing: "my-project" })).rejects.toThrow(
      `Cannot select an application in agent mode. ${UNDECIDED}. Pass --app <id>`,
    );

    expect(mockCreateApplication).not.toHaveBeenCalled();
    expect(mockSetProfile).not.toHaveBeenCalled();
    consoleSpy.mockRestore();
  });
});

// `clerk link` in a folder with an init token claims that app first, so a
// signed-in person or agent never reaches a picker that can't show it. One
// claim rule applies whatever the starting sign-in state: a person is asked,
// naming where the app goes; an agent can't answer, so it claims silently.
describe("a folder with an init token, not linked", () => {
  const INIT_CLAIM: InitClaim = { appName: "my-app", claimToken: "claim_token_init" };
  const INIT_APP = {
    application_id: "app_init",
    name: "my-app",
    instances: [
      { instance_id: "ins_init", environment_type: "development", publishable_key: "pk_test_init" },
    ],
  };
  const CLAIMED_AND_LINKED = {
    status: "claimed",
    app: INIT_APP,
    local: { kind: "linked", envPulled: true },
  };
  const ASK_ACCOUNT = (email: string) =>
    `Claim \`my-app\` (the app \`clerk init\` created in this folder) into ${email}'s account?`;
  const ASK_API_KEY =
    "Claim `my-app` (the app `clerk init` created in this folder) into the workspace your `CLERK_PLATFORM_API_KEY` belongs to?";

  beforeEach(() => {
    mockReadInitClaim.mockResolvedValue(INIT_CLAIM);
    mockAttemptAutoclaim.mockResolvedValue(CLAIMED_AND_LINKED);
  });

  function storedSession(email = "jane@example.com") {
    mockGetToken.mockResolvedValue("token");
    mockGetAuth.mockResolvedValue({ userId: "user_1" });
    mockFetchUserInfo.mockResolvedValue({ userId: "user_1", email });
  }

  function apiKeyOnly() {
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform_key";
    mockGetToken.mockResolvedValue(null);
  }

  function expectNoOtherWayToAnApp() {
    expect(mockAutolink).not.toHaveBeenCalled();
    expect(mockListApplications).not.toHaveBeenCalled();
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockCreateApplication).not.toHaveBeenCalled();
  }

  test.each([
    {
      who: "a person",
      agent: false,
      credentials: "a stored session",
      setUp: () => storedSession(),
      question: ASK_ACCOUNT("jane@example.com"),
    },
    {
      who: "a person",
      agent: false,
      credentials: "an API key",
      setUp: apiKeyOnly,
      question: ASK_API_KEY,
    },
    {
      who: "an agent",
      agent: true,
      credentials: "a stored session",
      setUp: () => storedSession(),
      question: undefined,
    },
    {
      who: "an agent",
      agent: true,
      credentials: "an API key",
      setUp: apiKeyOnly,
      question: undefined,
    },
  ])(
    "$who signed in with $credentials claims the app first, before auto-link and the picker",
    async ({ agent, setUp, question }) => {
      mockIsAgent.mockReturnValue(agent);
      setUp();
      mockConfirm.mockResolvedValue(true);

      const outcome = await link({});

      expect(mockAttemptAutoclaim).toHaveBeenCalledWith(expect.any(String), INIT_CLAIM);
      const asked: unknown[] = question ? [[{ message: question, default: true }]] : [];
      expect(mockConfirm.mock.calls as unknown[]).toEqual(asked);
      expect(outcome).toEqual({ status: "linked", appId: "app_init" });
      expectNoOtherWayToAnApp();
    },
  );

  test("a signed-out person signs in without login's own claim, then is asked about that account", async () => {
    mockIsAgent.mockReturnValue(false);
    mockGetToken.mockResolvedValue(null);
    mockLogin.mockResolvedValue({ userId: "user_new", email: "new@example.com" });
    mockConfirm.mockResolvedValue(true);

    await link({});

    expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false, claim: false });
    expect(mockConfirm.mock.calls).toEqual([
      [{ message: ASK_ACCOUNT("new@example.com"), default: true }],
    ]);
    expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
    expectNoOtherWayToAnApp();
  });

  // Control: an agent can't sign in from `clerk link`.
  test("a signed-out agent doesn't claim, and gets the existing agent error", async () => {
    mockIsAgent.mockReturnValue(true);
    mockGetToken.mockResolvedValue(null);

    await expect(link({})).rejects.toThrow("Cannot select an application in agent mode.");

    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
  });

  test("a person who answers No stops with a user abort, before any picker, and nothing is claimed", async () => {
    mockIsAgent.mockReturnValue(false);
    storedSession();
    mockConfirm.mockResolvedValue(false);

    await expect(link({})).rejects.toBeInstanceOf(UserAbortError);

    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
    expectNoOtherWayToAnApp();
  });

  // The claim left the folder unlinked: `clerk link` goes on to match the
  // folder's own key, but never creates an app, which `clerk init` would
  // write over keys the check just protected.
  test.each([
    {
      result: "claimed, folder holds another app's keys",
      claim: {
        status: "claimed",
        app: INIT_APP,
        local: {
          kind: "unchanged",
          reason: "different_keys",
          key: "publishable",
          name: "CLERK_PUBLISHABLE_KEY",
          source: ".env",
          mixed: false,
          linkCanTryKey: true,
        },
      },
    },
    {
      result: "claimed, couldn't tell",
      claim: {
        status: "claimed",
        app: INIT_APP,
        local: { kind: "unchanged", reason: "unverified" },
      },
    },
    {
      result: "claimed, link failed",
      claim: {
        status: "claimed",
        app: INIT_APP,
        local: { kind: "link_failed", reason: "read-only" },
      },
    },
    { result: "stale token", claim: { status: "not_found" } },
  ])(
    "$result: an agent goes on to match the folder's own key, and never creates an app",
    async ({ claim }) => {
      mockIsAgent.mockReturnValue(true);
      storedSession();
      mockAttemptAutoclaim.mockResolvedValue(claim);
      mockAutolink.mockResolvedValue({ status: "no_match", source: ".env" });
      const consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await expect(link({ skipIfLinked: true, createIfMissing: "my-project" })).rejects.toThrow(
        "Cannot select an application in agent mode.",
      );

      expect(mockAttemptAutoclaim).toHaveBeenCalledTimes(1);
      expect(mockAutolink).toHaveBeenCalledTimes(1);
      expect(mockCreateApplication).not.toHaveBeenCalled();
      consoleSpy.mockRestore();
    },
  );

  test("claimed but left alone: an agent links the app the folder's own key belongs to", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    mockAttemptAutoclaim.mockResolvedValue({
      status: "claimed",
      app: INIT_APP,
      local: { kind: "unchanged", reason: "unverified" },
    });
    mockAutolink.mockResolvedValue({
      status: "linked",
      path: "github.com/org/repo",
      profile: { workspaceId: "", appId: "app_other", instances: { development: "ins_other" } },
    });

    const outcome = await link({ skipIfLinked: true });

    expect(outcome).toEqual({ status: "linked", appId: "app_other" });
  });

  test.each([
    {
      refusal: "a workspace managed by an integration",
      claim: { status: "managed_workspace", longMessage: null },
    },
    { refusal: "an account with no organization", claim: { status: "no_organization" } },
  ])(
    "a refused claim ($refusal) stops with not_linked, never reaching the picker or creating an app",
    async ({ claim }) => {
      mockIsAgent.mockReturnValue(false);
      storedSession();
      mockConfirm.mockResolvedValue(true);
      mockAttemptAutoclaim.mockResolvedValue(claim);

      await expect(link({})).rejects.toMatchObject({ code: "not_linked" });

      expectNoOtherWayToAnApp();
    },
  );

  test("a temporary claim failure stops with the original error, never reaching the picker", async () => {
    mockIsAgent.mockReturnValue(false);
    storedSession();
    mockConfirm.mockResolvedValue(true);
    const serverError = new Error("Internal Server Error (500)");
    mockAttemptAutoclaim.mockResolvedValue({ status: "failed", error: serverError });

    await expect(link({})).rejects.toBe(serverError);

    expectNoOtherWayToAnApp();
  });

  // Controls: an explicit target wins.
  test("--app skips the claim", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    mockFetchApplication.mockResolvedValue(INIT_APP);

    await link({ app: "app_init" });

    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
  });

  test("a folder that's already linked skips the claim", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    mockResolveProfile.mockResolvedValue({
      path: "github.com/org/repo",
      profile: { workspaceId: "", appId: "app_other", instances: { development: "ins_other" } },
      resolvedVia: "remote",
    });

    await link({ skipIfLinked: true });

    expect(mockAttemptAutoclaim).not.toHaveBeenCalled();
  });
});

describe("signing in on the way to a link", () => {
  // `link` applies the claim rule itself, so login's own claim stays off.
  test("a signed-out person signs in without login's own claim", async () => {
    mockIsAgent.mockReturnValue(false);
    mockGetToken.mockResolvedValue(null);
    mockLogin.mockResolvedValue({ userId: "user_new", email: "new@example.com" });
    mockListApplications.mockResolvedValue([]);
    mockSearch.mockResolvedValue("__create_new__");

    await link({}).catch(() => {});

    expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false, claim: false });
  });
});
