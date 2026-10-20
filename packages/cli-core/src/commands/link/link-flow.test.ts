/**
 * `clerk link`'s decisions about which app a folder runs on: matching the key
 * the app loads, and refusing to guess when it can't tell.
 *
 * Separate from `index.test.ts` to keep each file under 50 KB: Bun caches the
 * transpiled form of larger files, and under Bun 1.3.14 a cache hit breaks the
 * version macro when tests run from `packages/cli-core`.
 */

import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  autolinkStubs,
  configStubs,
  credentialStoreStubs,
  gitStubs,
  listageStubs,
  useCaptureLog,
} from "../../test/lib/stubs.ts";

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
const mockResolveProfile = mock(async () => undefined);
mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  setProfile: (...args: unknown[]) => mockSetProfile(...args),
  resolveProfile: () => mockResolveProfile(),
}));

const mockAutolink = mock();
mock.module("../../lib/autolink.ts", () => ({
  ...autolinkStubs,
  autolink: (...args: unknown[]) => mockAutolink(...args),
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

afterEach(() => {
  for (const m of [
    mockIsAgent,
    mockGetToken,
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
