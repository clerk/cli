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
import { PlapiError, UserAbortError } from "../../lib/errors.ts";
import * as localKeys from "../../lib/local-keys.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCleanClerkKeyEnv, useSyntheticShellClerkKeys } from "../../test/lib/clerk-key-env.ts";

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
  hasAccountCredentials: async () =>
    Boolean(process.env.CLERK_PLATFORM_API_KEY) || Boolean(await mockGetToken()),
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
const mockFolderKeysBelongTo = mock(async (..._args: unknown[]): Promise<unknown> => ({
  verdict: "match",
}));
mock.module("../../lib/autoclaim.ts", () => ({
  readInitClaim: (cwd: string) => mockReadInitClaim(cwd),
  attemptAutoclaim: (...args: unknown[]) => mockAttemptAutoclaim(...args),
  // `clerk init`'s key check; covered end to end in `init-claim.test.ts`.
  folderKeysBelongTo: (...args: unknown[]) => mockFolderKeysBelongTo(...args),
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
const mockLinkApp = mock();
type MatchableApp = { instances: { publishable_key: string }[] };
mock.module("../../lib/autolink.ts", () => ({
  ...autolinkStubs,
  autolink: (cwd: string) => mockAutolink(cwd),
  linkApp: (...args: unknown[]) => mockLinkApp(...args),
  // Exact publishable-key equality, as the real matcher does.
  matchKeyToApp: (keys: { key: string; source: string }[], apps: MatchableApp[]) => {
    for (const { key, source } of keys) {
      for (const app of apps) {
        const instance = app.instances.find((i) => i.publishable_key === key);
        if (instance) return { app, instance, source };
      }
    }
    return undefined;
  },
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

const captured = useCaptureLog();

const savedApiKey = process.env.CLERK_PLATFORM_API_KEY;
const originalCwd = process.cwd();
/** An empty folder each test runs in, so no test reads this repo's own files. */
let workDir: string;

useSyntheticShellClerkKeys();
useCleanClerkKeyEnv();

beforeEach(async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  workDir = await mkdtemp(join(tmpdir(), "clerk-link-flow-"));
  process.chdir(workDir);
});

afterEach(async () => {
  process.chdir(originalCwd);
  await rm(workDir, { recursive: true, force: true });
  if (savedApiKey === undefined) delete process.env.CLERK_PLATFORM_API_KEY;
  else process.env.CLERK_PLATFORM_API_KEY = savedApiKey;
  mockFolderKeysBelongTo.mockReset();
  mockFolderKeysBelongTo.mockResolvedValue({ verdict: "match" });
  for (const m of [
    mockIsAgent,
    mockGetToken,
    mockFetchUserInfo,
    mockGetAuth,
    mockAttemptAutoclaim,
    mockLinkApp,
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

  // `clerk link` goes on to link the folder in the same run, so the report
  // says what the claim did and why, and names no command to run next.
  test.each([
    {
      result: "another app's key",
      local: {
        kind: "unchanged",
        reason: "different_keys",
        key: "publishable",
        name: "CLERK_PUBLISHABLE_KEY",
        source: ".env",
        mixed: false,
        linkCanTryKey: true,
      },
      says: "`CLERK_PUBLISHABLE_KEY` in .env isn't `my-app`'s, so this folder's link and keys were left alone.",
    },
    {
      result: "couldn't tell",
      local: { kind: "unchanged", reason: "unverified" },
      says: "Couldn't confirm this folder's Clerk keys belong to `my-app`, so this folder's link and keys were left alone.",
    },
    {
      result: "link failed",
      local: { kind: "link_failed", reason: "read-only" },
      says: "Linking this folder failed: read-only.",
    },
  ])(
    "claimed, $result: the report says why the folder wasn't linked, naming no next command",
    async ({ local, says }) => {
      mockIsAgent.mockReturnValue(true);
      storedSession();
      mockAttemptAutoclaim.mockResolvedValue({ status: "claimed", app: INIT_APP, local });
      mockAutolink.mockResolvedValue({ status: "no_match", source: ".env" });

      await link({ skipIfLinked: true }).catch(() => {});

      const output = Bun.stripANSI(captured.err);
      expect(output).toContain("Claimed application: `my-app`");
      expect(output).toContain(says);
      expect(output).not.toContain("clerk link");
      expect(output).not.toContain("clerk apps list");
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

// An SDK-only folder: no init token, no plain key, and the keys of an app a
// Clerk SDK created for itself in `.clerk/.tmp/keyless.json`. The CLI can't
// claim that app (there's no token), so `clerk link` looks for it in the
// account, and when it isn't there sends a person to claim it in the
// Dashboard. Never the picker: any app chosen there isn't the one the SDK runs.
describe("an SDK-only folder", () => {
  const SDK_PK = "pk_test_sdk_created_app";
  const CLAIM_URL = "https://dashboard.clerk.com/apps/claim?token=secret_claim_token";
  const SDK_APP = {
    application_id: "app_sdk",
    name: "SDK App",
    instances: [
      { instance_id: "ins_sdk", environment_type: "development", publishable_key: SDK_PK },
    ],
  };
  const OTHER_APP = {
    application_id: "app_other",
    name: "Other App",
    instances: [
      {
        instance_id: "ins_other",
        environment_type: "development",
        publishable_key: "pk_test_other",
      },
    ],
  };

  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clerk-link-sdk-"));
    mockLinkApp.mockImplementation(async (app: { application_id: string }) => ({
      path: "github.com/org/repo",
      profile: { workspaceId: "", appId: app.application_id, instances: {} },
    }));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function writeSdkFile(content: Record<string, unknown> | string) {
    await Bun.write(
      join(dir, ".clerk", ".tmp", "keyless.json"),
      typeof content === "string" ? content : JSON.stringify(content),
    );
  }

  function sdkFile(overrides: Record<string, unknown> = {}) {
    return writeSdkFile({
      publishableKey: SDK_PK,
      secretKey: "sk_test_sdk_created_app",
      claimUrl: CLAIM_URL,
      ...overrides,
    });
  }

  function storedSession(email = "jane@example.com") {
    mockGetToken.mockResolvedValue("token");
    mockGetAuth.mockResolvedValue({ userId: "user_1" });
    mockFetchUserInfo.mockResolvedValue({ userId: "user_1", email });
  }

  function expectNoPickerOrNewApp() {
    expect(mockSearch).not.toHaveBeenCalled();
    expect(mockCreateApplication).not.toHaveBeenCalled();
  }

  test.each([
    { who: "a person", agent: false },
    { who: "an agent", agent: true },
  ])("$who links the account's app whose key the SDK's file holds", async ({ agent }) => {
    mockIsAgent.mockReturnValue(agent);
    storedSession();
    await sdkFile();
    mockListApplications.mockResolvedValue([OTHER_APP, SDK_APP]);

    const outcome = await link({ cwd: dir });

    expect(outcome).toEqual({ status: "linked", appId: "app_sdk" });
    expect(mockLinkApp).toHaveBeenCalledWith(SDK_APP, dir);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expectNoPickerOrNewApp();
  });

  test("a signed-out person signs in without login's own claim, then the key is matched", async () => {
    mockIsAgent.mockReturnValue(false);
    mockGetToken.mockResolvedValue(null);
    mockLogin.mockResolvedValue({ userId: "user_new", email: "new@example.com" });
    await sdkFile();
    mockListApplications.mockResolvedValue([SDK_APP]);

    const outcome = await link({ cwd: dir });

    expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false, claim: false });
    expect(outcome).toEqual({ status: "linked", appId: "app_sdk" });
  });

  test("a person whose account lacks the app gets the claim page, never its URL, and nothing linked", async () => {
    mockIsAgent.mockReturnValue(false);
    storedSession();
    await sdkFile();
    mockListApplications.mockResolvedValue([OTHER_APP]);

    const outcome = await link({ cwd: dir });

    expect(outcome).toEqual({ status: "claim_page_opened" });
    expect(mockOpenBrowser.mock.calls).toEqual([[CLAIM_URL]]);
    const output = Bun.stripANSI(captured.err + captured.out);
    expect(output).not.toContain(CLAIM_URL);
    expect(output).not.toContain("secret_claim_token");
    expect(output).toContain(
      "This folder's app was created by the Clerk SDK and isn't in an account yet",
    );
    expect(output).toContain("clerk open --print");
    expect(mockLinkApp).not.toHaveBeenCalled();
    expect(mockSetProfile).not.toHaveBeenCalled();
    expectNoPickerOrNewApp();
  });

  test.each([
    { credentials: "a stored session", apiKey: false, account: "jane@example.com's account" },
    {
      credentials: "an API key",
      apiKey: true,
      account: "the workspace your `CLERK_PLATFORM_API_KEY` belongs to",
    },
  ])(
    "the claim page message names the account the rerun will search ($credentials)",
    async ({ apiKey, account }) => {
      mockIsAgent.mockReturnValue(false);
      storedSession();
      if (apiKey) process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform_key";
      await sdkFile();
      mockListApplications.mockResolvedValue([OTHER_APP]);

      await link({ cwd: dir });

      expect(Bun.stripANSI(captured.err)).toContain(`Claim it into ${account}`);
    },
  );

  test("when no browser can be opened, the message leads with that, and still never shows the URL", async () => {
    mockIsAgent.mockReturnValue(false);
    storedSession();
    await sdkFile();
    mockListApplications.mockResolvedValue([OTHER_APP]);
    mockOpenBrowser.mockResolvedValue({ ok: false, reason: "no-launcher" } as never);

    const outcome = await link({ cwd: dir });

    expect(outcome).toEqual({ status: "claim_page_opened" });
    const output = Bun.stripANSI(captured.err + captured.out);
    expect(output).toContain("Couldn't open a browser here");
    expect(output).toContain("clerk open --print");
    expect(output).not.toContain(CLAIM_URL);
  });

  test("an agent whose account lacks the app stops with usage_error naming `clerk open`, opening nothing", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    await sdkFile();
    mockListApplications.mockResolvedValue([OTHER_APP]);

    await expect(
      link({ cwd: dir, skipIfLinked: true, createIfMissing: "my-project" }),
    ).rejects.toMatchObject({
      code: "usage_error",
      message: expect.stringContaining("Run `clerk open`"),
    });

    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expect(mockLinkApp).not.toHaveBeenCalled();
    expectNoPickerOrNewApp();
  });

  test("an agent whose app list fails stops with usage_error naming the failed list", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    await sdkFile();
    mockListApplications.mockRejectedValue(new Error("Unauthorized (401)"));

    await expect(link({ cwd: dir })).rejects.toMatchObject({
      code: "usage_error",
      message: expect.stringContaining("couldn't list your applications"),
    });

    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expectNoPickerOrNewApp();
  });

  // A server error used to turn into a picker offering only "create a new
  // application", which links a new app while the SDK keeps running the old one.
  test("a person whose app list fails with a server error gets that error, never the picker or the claim page", async () => {
    mockIsAgent.mockReturnValue(false);
    storedSession();
    await sdkFile();
    mockListApplications.mockRejectedValue(
      new PlapiError(500, '{"errors":[{"message":"Internal Server Error"}]}'),
    );
    mockSearch.mockResolvedValue("__create_new__");

    await expect(link({ cwd: dir })).rejects.toBeInstanceOf(PlapiError);

    expect(mockOpenBrowser).not.toHaveBeenCalled();
    expectNoPickerOrNewApp();
  });

  // The CLI can't tell how to claim the app, so it never guesses with a picker.
  test.each([
    { file: "no claimUrl", write: () => sdkFile({ claimUrl: undefined }) },
    {
      file: "a claimUrl that isn't https",
      write: () => sdkFile({ claimUrl: "javascript:alert(1)" }),
    },
    { file: "no publishable key", write: () => sdkFile({ publishableKey: undefined }) },
    { file: "unreadable JSON", write: () => writeSdkFile("{ not json") },
  ])(
    "an SDK keyless file with $file stops both modes with usage_error, opening nothing",
    async ({ write }) => {
      storedSession();
      await write();
      // The app isn't in the account: a matched app links without a claim link.
      mockListApplications.mockResolvedValue([OTHER_APP]);

      for (const agent of [false, true]) {
        mockIsAgent.mockReturnValue(agent);
        await expect(link({ cwd: dir })).rejects.toMatchObject({
          code: "usage_error",
          message: expect.stringContaining("has no usable claim link"),
        });
      }

      expect(mockOpenBrowser).not.toHaveBeenCalled();
      expect(mockLinkApp).not.toHaveBeenCalled();
      expectNoPickerOrNewApp();
    },
  );

  // Matching needs no claim link; only sending a person to claim the app does.
  test.each([
    { who: "a person", agent: false },
    { who: "an agent", agent: true },
  ])(
    "$who links the account's app even when the SDK file has no usable claim URL",
    async ({ agent }) => {
      mockIsAgent.mockReturnValue(agent);
      storedSession();
      await sdkFile({ claimUrl: undefined });
      mockListApplications.mockResolvedValue([SDK_APP]);

      expect(await link({ cwd: dir })).toEqual({ status: "linked", appId: "app_sdk" });
    },
  );

  test("the claim page message names the command to rerun", async () => {
    mockIsAgent.mockReturnValue(false);
    storedSession();
    await sdkFile();
    mockListApplications.mockResolvedValue([OTHER_APP]);

    await link({ cwd: dir, rerun: "run `clerk init` again" });

    const output = Bun.stripANSI(captured.err);
    expect(output).toContain("then run `clerk init` again");
    expect(output).not.toContain("run `clerk link` again");
  });

  // After a claim that didn't link the folder, the token is gone: a folder
  // whose only keys are the SDK's is SDK-only, and the picker can't show its app.
  test("a token and only SDK keys, after a claim that left the folder alone: the claim page, never the picker", async () => {
    mockIsAgent.mockReturnValue(false);
    storedSession();
    await sdkFile();
    mockReadInitClaim.mockResolvedValue({ appName: "my-app", claimToken: "claim_token_init" });
    mockConfirm.mockResolvedValue(true);
    mockAttemptAutoclaim.mockResolvedValue({
      status: "claimed",
      app: OTHER_APP,
      local: { kind: "unchanged", reason: "unverified" },
    });
    mockListApplications.mockResolvedValue([OTHER_APP]);

    const outcome = await link({ cwd: dir });

    expect(outcome).toEqual({ status: "claim_page_opened" });
    expect(mockSearch).not.toHaveBeenCalled();
  });

  test("init's every-key check runs before the SDK step saves a link: a matched app that doesn't own every key isn't linked", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    await sdkFile();
    mockReadInitClaim.mockResolvedValue({ appName: "my-app", claimToken: "claim_token_init" });
    mockAttemptAutoclaim.mockResolvedValue({
      status: "claimed",
      app: OTHER_APP,
      local: { kind: "unchanged", reason: "unverified" },
    });
    mockListApplications.mockResolvedValue([SDK_APP]);
    mockFolderKeysBelongTo.mockResolvedValue({
      verdict: "mismatch",
      key: { name: "secretKey", source: ".clerk/.tmp/keyless.json" },
    });

    await expect(
      link({ cwd: dir, skipIfLinked: true, onlyIfFolderKeysMatch: true }),
    ).rejects.toMatchObject({ code: "not_linked" });

    expect(mockLinkApp).not.toHaveBeenCalled();
    expect(mockSetProfile).not.toHaveBeenCalled();
  });

  // Control: a plain key means the app runs on it, not on the SDK's file.
  test("a plain key next to a stale SDK keyless file: the SDK file's app isn't linked", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    await sdkFile();
    await Bun.write(join(dir, ".env"), "CLERK_PUBLISHABLE_KEY=pk_test_unmatched\n");
    mockListApplications.mockResolvedValue([SDK_APP]);
    mockAutolink.mockResolvedValue({ status: "no_match", source: ".env" });

    await expect(link({ cwd: dir })).rejects.toThrow("Cannot select an application in agent mode.");

    expect(mockLinkApp).not.toHaveBeenCalled();
  });

  // Nuxt loads only `.env`, so an `.env.local` the CLI can't read says nothing
  // about the keys the app runs on: the SDK step still decides.
  describe("in a Nuxt folder whose .env.local can't be read", () => {
    beforeEach(async () => {
      await Bun.write(
        join(dir, "package.json"),
        JSON.stringify({ dependencies: { nuxt: "4.0.0" } }),
      );
      spyOn(localKeys, "readAllFolderKeys").mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied, open '.env.local'"), {
          code: "EACCES",
        }),
      );
    });

    afterEach(() => {
      (localKeys.readAllFolderKeys as unknown as { mockRestore: () => void }).mockRestore();
    });

    test.each([
      { who: "a person", agent: false },
      { who: "an agent", agent: true },
    ])("$who still links the account's app whose key the SDK's file holds", async ({ agent }) => {
      mockIsAgent.mockReturnValue(agent);
      storedSession();
      await sdkFile();
      mockListApplications.mockResolvedValue([OTHER_APP, SDK_APP]);

      const outcome = await link({ cwd: dir });

      expect(outcome).toEqual({ status: "linked", appId: "app_sdk" });
      expectNoPickerOrNewApp();
    });
  });
});

// What `clerk link` may do when auto-link didn't link the folder: one decision
// for every case, so no path creates an app or reaches a picker it shouldn't.
describe("when auto-link doesn't link the folder", () => {
  const ACCOUNT_APP = {
    application_id: "app_account",
    name: "Account App",
    instances: [
      {
        instance_id: "ins_account",
        environment_type: "development",
        publishable_key: "pk_test_account_app",
      },
    ],
  };
  const INIT_CLAIM = { appName: "my-app", claimToken: "claim_token_init" };

  function storedSession() {
    mockGetToken.mockResolvedValue("token");
    mockGetAuth.mockResolvedValue({ userId: "user_1" });
    mockFetchUserInfo.mockResolvedValue({ userId: "user_1", email: "jane@example.com" });
  }

  async function writeFile(file: string, content: string) {
    await Bun.write(join(workDir, file), content);
  }

  /** A claim of the init app that left the folder alone. */
  function claimLeftFolderAlone() {
    mockReadInitClaim.mockResolvedValue(INIT_CLAIM);
    mockConfirm.mockResolvedValue(true);
    mockAttemptAutoclaim.mockResolvedValue({
      status: "claimed",
      app: ACCOUNT_APP,
      local: { kind: "unchanged", reason: "unverified" },
    });
  }

  /** The choices the person's picker offered, from its `source`. */
  function pickerChoices(): unknown[] {
    const config = mockSearch.mock.calls[0]?.[0] as {
      source: (term: string | undefined) => { value: string }[];
    };
    return config.source(undefined).map((choice) => choice.value);
  }

  // Creating is for a folder whose keys no account app holds: no key at all,
  // or one that matches nothing.
  test.each([
    { outcome: "no key", autolinked: { status: "no_key" } },
    { outcome: "a key no app matches", autolinked: { status: "no_match", source: ".env" } },
  ])(
    "an agent creates the app it was asked to when auto-link found $outcome",
    async ({ autolinked }) => {
      mockIsAgent.mockReturnValue(true);
      storedSession();
      mockAutolink.mockResolvedValue(autolinked);
      mockCreateApplication.mockResolvedValue({ ...ACCOUNT_APP, application_id: "app_new" });

      const outcome = await link({ skipIfLinked: true, createIfMissing: "my-project" });

      expect(mockCreateApplication).toHaveBeenCalledWith("my-project");
      expect(outcome).toEqual({ status: "linked", appId: "app_new" });
    },
  );

  test("an agent never creates an app when the app list failed: it stops, naming the failed list", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    mockAutolink.mockResolvedValue({
      status: "list_failed",
      error: new Error("Server Error (500)"),
    });

    await expect(link({ skipIfLinked: true, createIfMissing: "my-project" })).rejects.toMatchObject(
      {
        code: "usage_error",
        message: expect.stringContaining("couldn't list your applications"),
      },
    );

    expect(mockCreateApplication).not.toHaveBeenCalled();
  });

  test("the folder's key matching an app with no development instance stops with instance_not_found, creating nothing", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    mockAutolink.mockResolvedValue({ status: "no_development_instance", appId: "app_prod_only" });

    await expect(link({ skipIfLinked: true, createIfMissing: "my-project" })).rejects.toMatchObject(
      {
        code: "instance_not_found",
      },
    );

    expect(mockCreateApplication).not.toHaveBeenCalled();
  });

  test("an agent never creates an app when the folder's secret keys disagree", async () => {
    mockIsAgent.mockReturnValue(true);
    storedSession();
    await writeFile("package.json", JSON.stringify({ dependencies: { express: "4.0.0" } }));
    await writeFile(".env", "CLERK_SECRET_KEY=sk_test_one_app\n");
    await writeFile(".env.local", "CLERK_SECRET_KEY=sk_test_another_app\n");
    mockAutolink.mockResolvedValue({ status: "no_key" });

    await expect(link({ skipIfLinked: true, createIfMissing: "my-project" })).rejects.toMatchObject(
      {
        code: "usage_error",
        message: expect.stringContaining("hold different Clerk secret keys"),
      },
    );

    expect(mockCreateApplication).not.toHaveBeenCalled();
  });

  describe("an env file that can't be read", () => {
    const READ_FAILED = "couldn't read this folder's env files";

    beforeEach(() => {
      spyOn(localKeys, "readFolderKeys").mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied, open '.env.local'"), {
          code: "EACCES",
        }),
      );
    });

    afterEach(() => {
      (localKeys.readFolderKeys as unknown as { mockRestore: () => void }).mockRestore();
    });

    test("an agent gets the not-linked stop saying why, not a raw error", async () => {
      mockIsAgent.mockReturnValue(true);
      storedSession();

      await expect(
        link({ skipIfLinked: true, createIfMissing: "my-project" }),
      ).rejects.toMatchObject({
        code: "usage_error",
        message: expect.stringContaining(READ_FAILED),
      });

      expect(mockCreateApplication).not.toHaveBeenCalled();
    });

    test.each([
      { apps: "no apps", list: [] },
      { apps: "an app", list: [ACCOUNT_APP] },
    ])("a person whose account has $apps is told why, then gets the picker", async ({ list }) => {
      mockIsAgent.mockReturnValue(false);
      storedSession();
      mockListApplications.mockResolvedValue(list);
      mockSearch.mockResolvedValue(ACCOUNT_APP.application_id);
      mockFetchApplication.mockResolvedValue(ACCOUNT_APP);

      await link({}).catch(() => {});

      expect(Bun.stripANSI(captured.err)).toContain(READ_FAILED);
      expect(mockSearch).toHaveBeenCalledTimes(1);
      // No "Link to this application?" suggestion from a key it couldn't read.
      expect(mockConfirm).not.toHaveBeenCalled();
    });
  });

  // Nuxt loads only `.env`, but an `.env.local` the CLI can't read may still
  // hold a real app's keys.
  describe("an env file the framework doesn't load that can't be read", () => {
    beforeEach(async () => {
      await writeFile("package.json", JSON.stringify({ dependencies: { nuxt: "4.0.0" } }));
      spyOn(localKeys, "readAllFolderKeys").mockRejectedValue(
        Object.assign(new Error("EACCES: permission denied, open '.env.local'"), {
          code: "EACCES",
        }),
      );
    });

    afterEach(() => {
      (localKeys.readAllFolderKeys as unknown as { mockRestore: () => void }).mockRestore();
    });

    test("an agent never creates an app: it stops, saying why", async () => {
      mockIsAgent.mockReturnValue(true);
      storedSession();

      await expect(
        link({ skipIfLinked: true, createIfMissing: "my-project" }),
      ).rejects.toMatchObject({
        code: "usage_error",
        message: expect.stringContaining("couldn't read this folder's env files"),
      });

      expect(mockCreateApplication).not.toHaveBeenCalled();
    });
  });

  describe("init, after a claim that left the folder alone", () => {
    beforeEach(() => {
      mockIsAgent.mockReturnValue(false);
      storedSession();
      claimLeftFolderAlone();
    });

    // A new app's keys can't match keys the folder already holds, so init's
    // key check would reject it after it was created.
    test("the picker never offers to create an app while the folder holds keys", async () => {
      await writeFile(".env.local", "CLERK_SECRET_KEY=sk_test_some_app\n");
      mockAutolink.mockResolvedValue({ status: "no_key" });
      mockListApplications.mockResolvedValue([ACCOUNT_APP]);
      mockSearch.mockResolvedValue(ACCOUNT_APP.application_id);
      mockFetchApplication.mockResolvedValue(ACCOUNT_APP);

      await link({ skipIfLinked: true, onlyIfFolderKeysMatch: true });

      expect(pickerChoices()).not.toContain("__create_new__");
      expect(pickerChoices()).toContain(ACCOUNT_APP.application_id);
      expect(mockCreateApplication).not.toHaveBeenCalled();
    });

    // Files that disagree may be one app's development and production keys,
    // which the check accepts: the person picks, and the check decides.
    test("files that disagree get the picker, without creating", async () => {
      await writeFile("package.json", JSON.stringify({ dependencies: { express: "4.0.0" } }));
      await writeFile(".env", "CLERK_PUBLISHABLE_KEY=pk_live_account_app\n");
      await writeFile(".env.local", "CLERK_PUBLISHABLE_KEY=pk_test_account_app\n");
      mockAutolink.mockResolvedValue({ status: "couldnt_tell", reason: "files disagree" });
      mockListApplications.mockResolvedValue([ACCOUNT_APP]);
      mockSearch.mockResolvedValue(ACCOUNT_APP.application_id);
      mockFetchApplication.mockResolvedValue(ACCOUNT_APP);

      expect(await link({ skipIfLinked: true, onlyIfFolderKeysMatch: true })).toEqual({
        status: "linked",
        appId: ACCOUNT_APP.application_id,
      });
      expect(pickerChoices()).not.toContain("__create_new__");
    });

    test("with no app to choose and creating off, it stops with not_linked instead of an empty picker", async () => {
      await writeFile(".env.local", "CLERK_SECRET_KEY=sk_test_some_app\n");
      mockAutolink.mockResolvedValue({ status: "no_key" });
      mockListApplications.mockResolvedValue([]);

      await expect(link({ skipIfLinked: true, onlyIfFolderKeysMatch: true })).rejects.toMatchObject(
        {
          code: "not_linked",
        },
      );

      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockCreateApplication).not.toHaveBeenCalled();
    });

    // No app can pass the check when a key line can't be read.
    test("a key line it can't read stops with not_linked before the picker", async () => {
      await writeFile("package.json", JSON.stringify({ dependencies: { next: "15.0.0" } }));
      await writeFile(".env.local", "  NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=pk_test_indented\n");
      mockAutolink.mockResolvedValue({ status: "couldnt_tell", reason: "unreadable" });
      mockListApplications.mockResolvedValue([ACCOUNT_APP]);

      await expect(link({ skipIfLinked: true, onlyIfFolderKeysMatch: true })).rejects.toMatchObject(
        {
          code: "not_linked",
        },
      );

      expect(mockSearch).not.toHaveBeenCalled();
    });

    test("an exported key that isn't the chosen app's is named as an env var", async () => {
      mockAutolink.mockResolvedValue({ status: "no_key" });
      mockListApplications.mockResolvedValue([ACCOUNT_APP]);
      mockSearch.mockResolvedValue(ACCOUNT_APP.application_id);
      mockFetchApplication.mockResolvedValue(ACCOUNT_APP);
      mockFolderKeysBelongTo.mockResolvedValue({
        verdict: "mismatch",
        key: { name: "CLERK_SECRET_KEY", source: "CLERK_SECRET_KEY env var" },
      });

      const error = await link({ skipIfLinked: true, onlyIfFolderKeysMatch: true }).catch(
        (thrown: unknown) => thrown as Error,
      );

      expect(error).toMatchObject({ code: "not_linked" });
      expect((error as Error).message).toContain("The `CLERK_SECRET_KEY` env var isn't");
      expect((error as Error).message).not.toContain("in CLERK_SECRET_KEY env var");
    });
  });
});
