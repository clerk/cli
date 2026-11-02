import { test, expect, describe, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "@commander-js/extra-typings";
import {
  useCaptureLog,
  configStubs,
  credentialStoreStubs,
  autolinkStubs,
  gitStubs,
  listageStubs,
} from "../../test/lib/stubs.ts";
import { CliError, ERROR_CODE, EXIT_CODE, PlapiError } from "../../lib/errors.ts";
import "../../lib/help.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";

const mockIsAgent = mock();
let _modeOverride: string | undefined;
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride === "agent" : mockIsAgent(...args),
  isHuman: (...args: unknown[]) =>
    _modeOverride !== undefined ? _modeOverride !== "agent" : !mockIsAgent(...args),
  setMode: (m: string) => {
    _modeOverride = m;
  },
  getMode: () => _modeOverride ?? "human",
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
const mockClaimApplication = mock();
mock.module("../../lib/plapi.ts", () => ({
  claimApplication: (...args: unknown[]) => mockClaimApplication(...args),
  validateKeyPrefix: () => {},
  listApplications: (...args: unknown[]) => mockListApplications(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
  createApplication: (...args: unknown[]) => mockCreateApplication(...args),
  PlapiError: class PlapiError extends Error {},
  fetchInstanceConfig: async () => ({}),
  putInstanceConfig: async () => ({}),
  patchInstanceConfig: async () => ({}),
}));

const mockSetProfile = mock();
const mockResolveProfile = mock();
const mockMoveProfile = mock();
mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  setProfile: (...args: unknown[]) => mockSetProfile(...args),
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
  moveProfile: (...args: unknown[]) => mockMoveProfile(...args),
}));

const mockAutolink = mock();
const mockFindClerkKeys = mock();
const mockMatchKeyToApp = mock();
const mockLinkApp = mock();
mock.module("../../lib/autolink.ts", () => ({
  ...autolinkStubs,
  linkApp: (...args: unknown[]) => mockLinkApp(...args),
  autolink: (...args: unknown[]) => mockAutolink(...args),
  findClerkKeys: (...args: unknown[]) => mockFindClerkKeys(...args),
  matchKeyToApp: (...args: unknown[]) => mockMatchKeyToApp(...args),
}));

const mockGetGitRepoIdentifier = mock();
const mockGetGitRepoRoot = mock();
const mockGetGitNormalizedRemote = mock();
mock.module("../../lib/git.ts", () => ({
  ...gitStubs,
  getGitRepoIdentifier: (...args: unknown[]) => mockGetGitRepoIdentifier(...args),
  getGitRepoRoot: (...args: unknown[]) => mockGetGitRepoRoot(...args),
  getGitNormalizedRemote: (...args: unknown[]) => mockGetGitNormalizedRemote(...args),
}));

const mockSearch = mock();
const mockOutro = mock();
const mockConfirm = mock();
const mockInput = mock();
mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: (...args: unknown[]) => mockInput(...args),
  password: async () => "",
  editor: async () => "",
}));

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  search: (...args: unknown[]) => mockSearch(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: (...args: unknown[]) => mockOutro(...args),
  pausedOutro: () => {},
  bar: () => {},
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const mockPull = mock();
mock.module("../env/pull.ts", () => ({
  pull: (...args: unknown[]) => mockPull(...args),
}));

const { link, replacedLink, registerLink } = await import("./index.ts");

const mockApp = {
  application_id: "app_123",
  instances: [
    {
      instance_id: "ins_dev",
      environment_type: "development",
      secret_key: "sk_test",
      publishable_key: "pk_test",
    },
    {
      instance_id: "ins_prod",
      environment_type: "production",
      secret_key: "sk_live",
      publishable_key: "pk_live",
    },
  ],
};

/** Shell variables `link()` and the claim read; a developer's own must not decide these tests. */
const SHELL_VARS = ["CLERK_PLATFORM_API_KEY", "CLERK_PUBLISHABLE_KEY"];
const originalShell = Object.fromEntries(SHELL_VARS.map((name) => [name, process.env[name]]));

describe("link", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(() => {
    for (const name of SHELL_VARS) delete process.env[name];
  });

  afterEach(() => {
    for (const name of SHELL_VARS) {
      if (originalShell[name] === undefined) delete process.env[name];
      else process.env[name] = originalShell[name];
    }
  });

  // Run before each test as well as after, so a test's defaults never depend on the test before it.
  function resetMocks() {
    _modeOverride = undefined;
    mockIsAgent.mockReset();
    mockGetToken.mockReset();
    mockLogin.mockReset();
    mockListApplications.mockReset();
    mockFetchApplication.mockReset();
    mockCreateApplication.mockReset();
    mockClaimApplication.mockReset();
    mockLinkApp.mockReset();
    mockPull.mockReset();
    mockSetProfile.mockReset();
    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue(undefined);
    mockAutolink.mockReset();
    mockAutolink.mockResolvedValue(undefined);
    mockFindClerkKeys.mockReset();
    mockFindClerkKeys.mockResolvedValue([]);
    mockMatchKeyToApp.mockReset();
    mockMatchKeyToApp.mockReturnValue(undefined);
    mockMoveProfile.mockReset();
    mockGetGitRepoIdentifier.mockReset();
    mockGetGitRepoIdentifier.mockResolvedValue("/repo/.git");
    mockGetGitRepoRoot.mockReset();
    mockGetGitRepoRoot.mockResolvedValue("/repo");
    mockGetGitNormalizedRemote.mockReset();
    mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
    mockSearch.mockReset();
    mockOutro.mockReset();
    mockConfirm.mockReset();
    mockInput.mockReset();
  }

  beforeEach(resetMocks);

  afterEach(() => {
    resetMocks();
    consoleSpy?.mockRestore();
  });

  function runLink(options?: Parameters<typeof link>[0]) {
    return link(options);
  }

  describe("agent mode", () => {
    test("links directly with --app", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
      expect(mockSetProfile).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          appId: "app_123",
          instances: expect.objectContaining({ development: "ins_dev", production: "ins_prod" }),
        }),
      );
    });

    test("auto-links without prompts when a key match is available", async () => {
      mockIsAgent.mockReturnValue(true);
      mockAutolink.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_auto", instances: { development: "ins_dev" } },
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
    });

    test("returns current link status when already linked and no app is provided", async () => {
      mockIsAgent.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(captured.err).toContain("Already linked");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockFetchApplication).not.toHaveBeenCalled();
      expect(mockSetProfile).not.toHaveBeenCalled();
    });

    test("re-links directly when already linked and --app differs", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
      expect(mockSetProfile).toHaveBeenCalled();
    });

    test("errors when no deterministic app selection is available", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await expect(runLink()).rejects.toThrow(
        "Cannot select an application in agent mode. Pass --app <id>",
      );

      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
    });

    test("creates and links a new app when createIfMissing is provided", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockCreateApplication.mockResolvedValue({ ...mockApp, application_id: "app_new" });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ createIfMissing: "my-project" });

      expect(mockCreateApplication).toHaveBeenCalledWith("my-project");
      expect(mockFetchApplication).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalled();
    });

    test("autolink takes precedence over createIfMissing when keys match", async () => {
      mockIsAgent.mockReturnValue(true);
      mockAutolink.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ createIfMissing: "my-project" });

      expect(mockAutolink).toHaveBeenCalled();
      expect(mockCreateApplication).not.toHaveBeenCalled();
    });
  });

  describe("already linked", () => {
    test("notifies and returns when user declines re-link", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(false);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      const output = captured.err;
      expect(output).toContain("Already linked");
      expect(output).toContain("app_existing");
      expect(mockConfirm).toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
    });

    test("proceeds with re-link when user confirms", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(true);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalled();
    });
  });

  describe("skipIfLinked", () => {
    test("returns early when linked and no --app given", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ skipIfLinked: true });

      expect(captured.err).toContain("Already linked");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockFetchApplication).not.toHaveBeenCalled();
      expect(mockSetProfile).not.toHaveBeenCalled();
    });

    test("returns early when linked to the same app as --app", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_123", instances: { development: "ins_1" } },
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ skipIfLinked: true, app: "app_123" });

      expect(captured.err).toContain("Already linked");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockFetchApplication).not.toHaveBeenCalled();
      expect(mockSetProfile).not.toHaveBeenCalled();
    });

    test("falls through to re-link prompt when --app differs from existing link", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      mockConfirm.mockResolvedValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ skipIfLinked: true, app: "app_123" });

      expect(mockConfirm).toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
      expect(mockSetProfile).toHaveBeenCalled();
    });
  });

  describe("authentication", () => {
    test("calls login when no token exists", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue(null);
      mockLogin.mockResolvedValue({ userId: "user_1", email: "test@test.com" });
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockLogin).toHaveBeenCalled();
    });

    test("skips login when token exists", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("oauth_token_123");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockLogin).not.toHaveBeenCalled();
    });

    test("suppresses auth next-steps when login runs during link", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue(null);
      mockLogin.mockResolvedValue({ userId: "user_1", email: "test@test.com" });
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false });
    });
  });

  describe("app selection", () => {
    test("uses --app flag to skip picker", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockListApplications).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
    });

    test("shows interactive picker when no --app flag", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        {
          application_id: "app_a",
          instances: [
            { instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" },
          ],
        },
        {
          application_id: "app_b",
          instances: [
            { instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" },
          ],
        },
      ]);
      mockSearch.mockResolvedValue("app_a");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockListApplications).toHaveBeenCalled();
      expect(mockSearch).toHaveBeenCalled();
      expect(mockFetchApplication).not.toHaveBeenCalled();
    });

    test("source returns create option first, then all choices, when term is empty", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        {
          name: "My App",
          application_id: "app_a",
          instances: [
            { instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" },
          ],
        },
        {
          name: "Other App",
          application_id: "app_b",
          instances: [
            { instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" },
          ],
        },
      ]);
      mockSearch.mockImplementation(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          const results = config.source(undefined);
          expect(results).toHaveLength(3); // create option + 2 apps
          expect(results[0]!.value).toBe("__create_new__");
          expect(results[1]!.value).toBe("app_a");
          expect(results[2]!.value).toBe("app_b");
          return "app_a";
        },
      );
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();
    });

    test("source filters choices by name substring (case-insensitive), keeps create option", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        {
          name: "My App",
          application_id: "app_a",
          instances: [
            { instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" },
          ],
        },
        {
          name: "Other App",
          application_id: "app_b",
          instances: [
            { instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" },
          ],
        },
      ]);
      mockSearch.mockImplementation(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          const results = config.source("my");
          expect(results).toHaveLength(2); // create option + 1 match
          expect(results[0]!.value).toBe("__create_new__");
          expect(results[1]!.value).toBe("app_a");

          const noMatch = config.source("zzz");
          expect(noMatch).toHaveLength(1); // only create option
          expect(noMatch[0]!.value).toBe("__create_new__");

          return "app_a";
        },
      );
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();
    });

    test("source filters by app ID when name is absent", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        {
          application_id: "app_abc",
          instances: [
            { instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" },
          ],
        },
        {
          name: "Named",
          application_id: "app_xyz",
          instances: [
            { instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" },
          ],
        },
      ]);
      mockSearch.mockImplementation(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          const results = config.source("abc");
          expect(results).toHaveLength(2); // create option + 1 match
          expect(results[0]!.value).toBe("__create_new__");
          expect(results[1]!.value).toBe("app_abc");
          return "app_abc";
        },
      );
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();
    });

    test("shows picker with create option when no apps found", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([]);
      mockSearch.mockImplementation(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          const results = config.source(undefined);
          expect(results).toHaveLength(1);
          expect(results[0]!.value).toBe("__create_new__");
          return "__create_new__";
        },
      );
      mockInput.mockResolvedValue("New App");
      mockCreateApplication.mockResolvedValue({
        application_id: "app_created",
        name: "New App",
        instances: [],
      });
      mockFetchApplication.mockResolvedValue({
        application_id: "app_created",
        name: "New App",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test" },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockCreateApplication).toHaveBeenCalledWith("New App");
      expect(mockFetchApplication).toHaveBeenCalledWith("app_created");
      expect(mockSetProfile).toHaveBeenCalled();
    });

    test("shows picker with only create option when listApplications fails with 500", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockRejectedValue(PlapiError.fromBody(500, "Internal Server Error"));
      mockSearch.mockImplementation(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          const results = config.source(undefined);
          expect(results).toHaveLength(1);
          expect(results[0]!.value).toBe("__create_new__");
          return "__create_new__";
        },
      );
      mockInput.mockResolvedValue("My App");
      mockCreateApplication.mockResolvedValue({
        application_id: "app_new",
        name: "My App",
        instances: [],
      });
      mockFetchApplication.mockResolvedValue({
        application_id: "app_new",
        name: "My App",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test" },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockCreateApplication).toHaveBeenCalledWith("My App");
      expect(mockSetProfile).toHaveBeenCalled();
    });

    test("propagates listApplications errors that are not 5xx", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockRejectedValue(PlapiError.fromBody(401, "Unauthorized"));

      await expect(runLink()).rejects.toBeInstanceOf(PlapiError);
    });
  });

  describe("profile storage", () => {
    test("stores profile keyed by normalized remote URL", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockGetGitRepoIdentifier.mockResolvedValue("/repo/.git");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockSetProfile).toHaveBeenCalledWith("github.com/org/repo", {
        workspaceId: "",
        appId: "app_123",
        instances: {
          development: "ins_dev",
          production: "ins_prod",
        },
      });
    });

    test("falls back to git repo identifier when no remote", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      mockGetGitNormalizedRemote.mockResolvedValue(undefined);
      mockGetGitRepoIdentifier.mockResolvedValue("/repo/.git");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockSetProfile).toHaveBeenCalledWith("/repo/.git", {
        workspaceId: "",
        appId: "app_123",
        instances: {
          development: "ins_dev",
          production: "ins_prod",
        },
      });
    });

    test("falls back to cwd when not in a git repo", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      mockGetGitNormalizedRemote.mockResolvedValue(undefined);
      mockGetGitRepoIdentifier.mockResolvedValue(undefined);
      mockGetGitRepoRoot.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockSetProfile).toHaveBeenCalledWith(process.cwd(), {
        workspaceId: "",
        appId: "app_123",
        instances: {
          development: "ins_dev",
          production: "ins_prod",
        },
      });
    });

    test("omits production when not available", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue({
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            secret_key: "sk_test",
            publishable_key: "pk_test",
          },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      const storedProfile = mockSetProfile.mock.calls[0]![1];
      expect(storedProfile.instances.production).toBeUndefined();
    });

    test("exits when no development instance", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue({
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_prod",
            environment_type: "production",
            secret_key: "sk_live",
            publishable_key: "pk_live",
          },
        ],
      });

      await expect(runLink({ app: "app_123" })).rejects.toThrow(
        "Application has no development instance",
      );
    });

    test("logs confirmation message", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(captured.err).toContain("Linked to");
      expect(mockOutro).toHaveBeenCalledWith(NEXT_STEPS.LINK);
    });

    test("skips its next steps when the caller continues setup", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123", showNextSteps: false });

      expect(mockOutro).toHaveBeenCalledWith(undefined);
    });
  });

  describe("auto-link via remote", () => {
    test("prints auto-link notice when resolved via remote", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
        resolvedVia: "remote",
      });
      mockConfirm.mockResolvedValue(false);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      const output = captured.err;
      expect(output).toContain("Auto-linked via git remote");
      expect(output).toContain("github.com/org/repo");
    });

    test("skips silently with skipIfLinked after printing auto-link notice", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
        resolvedVia: "remote",
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ skipIfLinked: true });

      const output = captured.err;
      expect(output).toContain("Auto-linked via git remote");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    test("does not print auto-link notice when resolved via git-common-dir", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
        resolvedVia: "git-common-dir",
      });
      mockConfirm.mockResolvedValue(false);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      const output = captured.err;
      expect(output).not.toContain("Auto-linked via git remote");
      expect(output).toContain("Already linked");
    });
  });

  describe("profile upgrade to remote", () => {
    const dirProfile = {
      path: "/projects/myapp",
      profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      resolvedVia: "directory" as const,
      availableRemote: "github.com/org/repo",
    };

    test("offers upgrade when directory-keyed profile has available remote", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue(dirProfile);
      mockConfirm.mockResolvedValueOnce(true); // accept upgrade
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      const output = captured.err;
      expect(output).toContain("git repository with remote");
      expect(output).toContain("Link updated");
      expect(mockMoveProfile).toHaveBeenCalledWith("/projects/myapp", "github.com/org/repo");
    });

    test("falls through to re-link when upgrade is declined", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue(dirProfile);
      mockConfirm
        .mockResolvedValueOnce(false) // decline upgrade
        .mockResolvedValueOnce(false); // decline re-link
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockMoveProfile).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    test("skips upgrade prompt with skipIfLinked", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue(dirProfile);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ skipIfLinked: true });

      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockMoveProfile).not.toHaveBeenCalled();
    });

    test("offers upgrade for git-common-dir profile with available remote", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue({
        ...dirProfile,
        path: "/repo/.git",
        resolvedVia: "git-common-dir",
        availableRemote: "github.com/org/repo",
      });
      mockConfirm.mockResolvedValueOnce(true); // accept upgrade
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockMoveProfile).toHaveBeenCalledWith("/repo/.git", "github.com/org/repo");
    });
  });

  describe("autolink from detected keys", () => {
    test("suggests detected app and links when user confirms", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockFindClerkKeys.mockResolvedValue([
        { key: "pk_test", source: "CLERK_PUBLISHABLE_KEY env var" },
      ]);
      mockMatchKeyToApp.mockReturnValue({
        app: mockApp,
        instance: mockApp.instances[0],
        source: "CLERK_PUBLISHABLE_KEY env var",
      });
      mockConfirm.mockResolvedValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockFindClerkKeys).toHaveBeenCalled();
      expect(mockMatchKeyToApp).toHaveBeenCalled();
      expect(mockConfirm).toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalledWith("github.com/org/repo", {
        workspaceId: "",
        appId: "app_123",
        instances: {
          development: "ins_dev",
          production: "ins_prod",
        },
      });
      expect(mockSearch).not.toHaveBeenCalled();
    });

    test("shows picker when user declines suggested app", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      const otherApp = {
        application_id: "app_other",
        name: "Other App",
        instances: [
          {
            instance_id: "ins_dev_other",
            environment_type: "development",
            publishable_key: "pk_other",
          },
        ],
      };
      mockListApplications.mockResolvedValue([mockApp, otherApp]);
      mockFindClerkKeys.mockResolvedValue([
        { key: "pk_test", source: "CLERK_PUBLISHABLE_KEY env var" },
      ]);
      mockMatchKeyToApp.mockReturnValue({
        app: mockApp,
        instance: mockApp.instances[0],
        source: "CLERK_PUBLISHABLE_KEY env var",
      });
      mockConfirm.mockResolvedValue(false);
      mockSearch.mockResolvedValue("app_other");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockSearch).toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalledWith(
        "github.com/org/repo",
        expect.objectContaining({ appId: "app_other" }),
      );
    });

    test("skips key detection when --app flag is provided", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockFindClerkKeys).not.toHaveBeenCalled();
      expect(mockMatchKeyToApp).not.toHaveBeenCalled();
    });

    test("returns silently with skipIfLinked when autolink succeeds", async () => {
      mockIsAgent.mockReturnValue(false);
      mockAutolink.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_detected", instances: { development: "ins_1" } },
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});
      spyOn(console, "error").mockImplementation(() => {});

      await runLink({ skipIfLinked: true });

      expect(mockAutolink).toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    test("falls through to picker when no keys detected", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockFindClerkKeys.mockResolvedValue([]);
      mockSearch.mockResolvedValue("app_123");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockFindClerkKeys).toHaveBeenCalled();
      expect(mockMatchKeyToApp).not.toHaveBeenCalled();
      expect(mockSearch).toHaveBeenCalled();
    });

    test("falls through to picker when keys don't match any app", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockFindClerkKeys.mockResolvedValue([{ key: "sk_unknown", source: ".env" }]);
      mockMatchKeyToApp.mockReturnValue(undefined);
      mockSearch.mockResolvedValue("app_123");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockMatchKeyToApp).toHaveBeenCalled();
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockSearch).toHaveBeenCalled();
    });
  });

  describe("re-link skips key detection", () => {
    test("skips key suggestion and shows picker when re-linking", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(true);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("app_123");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockFindClerkKeys).not.toHaveBeenCalled();
      expect(mockMatchKeyToApp).not.toHaveBeenCalled();
      expect(mockSearch).toHaveBeenCalled();
    });

    test("skips key suggestion when re-linking from auto-linked remote", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
        resolvedVia: "remote",
      });
      mockConfirm.mockResolvedValue(true);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("app_123");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      const output = captured.err;
      expect(output).toContain("Auto-linked via git remote");
      expect(mockFindClerkKeys).not.toHaveBeenCalled();
      expect(mockSearch).toHaveBeenCalled();
    });

    test("skips key suggestion but respects --app flag when re-linking", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(true);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      expect(mockFindClerkKeys).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
    });

    test("shows target app name in re-link prompt when --app is provided", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      const namedApp = { ...mockApp, name: "My Cool App" };
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(namedApp);
      mockConfirm.mockResolvedValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink({ app: "app_123" });

      const confirmCall = mockConfirm.mock.calls.find((c: unknown[]) =>
        (c[0] as { message: string }).message.includes("Re-link"),
      );
      expect(confirmCall).toBeDefined();
      expect((confirmCall![0] as { message: string }).message).toContain("My Cool App");
    });

    test("does not show app name in re-link prompt without --app", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(true);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("app_123");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      const confirmCall = mockConfirm.mock.calls.find((c: unknown[]) =>
        (c[0] as { message: string }).message.includes("Re-link"),
      );
      expect(confirmCall).toBeDefined();
      expect((confirmCall![0] as { message: string }).message).toBe(
        "Re-link to a different application?",
      );
    });

    test("still suggests key match on first-time link", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockFindClerkKeys.mockResolvedValue([
        { key: "pk_test", source: "CLERK_PUBLISHABLE_KEY env var" },
      ]);
      mockMatchKeyToApp.mockReturnValue({
        app: mockApp,
        instance: mockApp.instances[0],
        source: "CLERK_PUBLISHABLE_KEY env var",
      });
      mockConfirm.mockResolvedValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockFindClerkKeys).toHaveBeenCalled();
      expect(mockMatchKeyToApp).toHaveBeenCalled();
      const output = captured.err;
      expect(output).toContain("We found");
    });

    test("skips key suggestion after declining profile upgrade", async () => {
      mockIsAgent.mockReturnValue(false);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
        resolvedVia: "git-common-dir",
        availableRemote: "github.com/org/repo",
      });
      mockConfirm
        .mockResolvedValueOnce(false) // decline upgrade
        .mockResolvedValueOnce(true); // accept re-link
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("app_123");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockFindClerkKeys).not.toHaveBeenCalled();
      expect(mockSearch).toHaveBeenCalled();
    });
  });

  describe("claiming the app a signed-out clerk init created", () => {
    const claimedApp = {
      application_id: "app_claimed",
      name: "My Init App",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_init",
        },
      ],
    };
    let folder = "";

    beforeEach(async () => {
      folder = await mkdtemp(join(tmpdir(), "clerk-link-claim-test-"));
      await mkdir(join(folder, ".clerk"), { recursive: true });
      await Bun.write(
        join(folder, ".clerk", "keyless.json"),
        JSON.stringify({ claimToken: "tok_init", createdAt: "2026-11-02T00:00:00.000Z" }),
      );
      mockLinkApp.mockResolvedValue({ path: folder, profile: {} });
      mockPull.mockResolvedValue(undefined);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    });

    afterEach(async () => {
      await rm(folder, { recursive: true, force: true });
    });

    function breadcrumbExists() {
      return Bun.file(join(folder, ".clerk", "keyless.json")).exists();
    }

    test("signed out: signs in without letting login claim, then claims and links once", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue(null);
      mockLogin.mockResolvedValue({ email: "a@b.c" });
      mockClaimApplication.mockResolvedValue(claimedApp);

      await runLink({ cwd: folder, claimKeylessApp: true });

      expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false, claim: false });
      expect(mockClaimApplication).toHaveBeenCalledTimes(1);
      expect(mockClaimApplication).toHaveBeenCalledWith("tok_init", expect.any(String));
      expect(mockLinkApp).toHaveBeenCalledWith(claimedApp, folder);
      expect(mockPull).toHaveBeenCalledWith({});
      expect(captured.err).toContain("Claimed and linked application: `My Init App`");
      expect(mockOutro).toHaveBeenLastCalledWith(NEXT_STEPS.AUTOCLAIMED);
      expect(captured.err).toContain("Your app now lives in your Clerk account:");
      expect(mockListApplications).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(await breadcrumbExists()).toBe(false);
    });

    test("agent mode, signed in: claims and links without prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockClaimApplication.mockResolvedValue(claimedApp);

      await runLink({ cwd: folder, claimKeylessApp: true });

      expect(mockLogin).not.toHaveBeenCalled();
      expect(mockLinkApp).toHaveBeenCalledWith(claimedApp, folder);
      expect(captured.err).toContain("Claimed and linked application: `My Init App`");
      expect(mockConfirm).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockAutolink).not.toHaveBeenCalled();
    });

    const TEMPORARY =
      "Couldn't claim the application `clerk init` created because of a temporary error. " +
      "Rerun `clerk link` to retry, or run `clerk link --app <app_id>` to link a different application";

    test.each([
      ["agent", 500],
      ["human", 500],
      ["agent", 429],
    ])(
      "%s mode: a %d claim response stops with the API error, worded as temporary, and keeps the token",
      async (mode, status) => {
        mockIsAgent.mockReturnValue(mode === "agent");
        mockGetToken.mockResolvedValue("token");
        mockClaimApplication.mockRejectedValue(new PlapiError(status as number, "Server Error"));

        const error = await runLink({ cwd: folder, claimKeylessApp: true }).catch(
          (caught: unknown) => caught,
        );

        // The global handler prints "<context> (<status>): <reason>" and the API's code as JSON.
        expect(error).toBeInstanceOf(PlapiError);
        expect((error as PlapiError).status).toBe(status);
        expect((error as PlapiError).context).toBe(TEMPORARY);
        // The advice lives in the error only, so it prints once.
        expect(captured.err).not.toContain("temporary error");
        expect(mockAutolink).not.toHaveBeenCalled();
        expect(mockSearch).not.toHaveBeenCalled();
        expect(mockLinkApp).not.toHaveBeenCalled();
        expect(await breadcrumbExists()).toBe(true);
      },
    );

    test("agent mode: a 400 says Clerk rejected the claim and points at --app, not a retry", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      const body = JSON.stringify({
        errors: [{ code: "form_param_invalid", message: "Invalid claim token" }],
      });
      mockClaimApplication.mockRejectedValue(new PlapiError(400, body));

      const error = await runLink({ cwd: folder, claimKeylessApp: true }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBeInstanceOf(PlapiError);
      expect((error as PlapiError).code).toBe("form_param_invalid");
      expect((error as PlapiError).status).toBe(400);
      expect((error as PlapiError).message).toBe("Invalid claim token");
      expect((error as PlapiError).context).toBe(
        "Clerk rejected the claim of the application `clerk init` created. " +
          "Run `clerk link --app <app_id>` with the application this folder should use",
      );
      expect(captured.err).not.toContain("Rerun `clerk link` to retry");
      expect(mockAutolink).not.toHaveBeenCalled();
      expect(await breadcrumbExists()).toBe(true);
    });

    test("a network failure during the claim stops with that error as it is, after a warning", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      const networkError = new TypeError("fetch failed");
      mockClaimApplication.mockRejectedValue(networkError);

      const error = await runLink({ cwd: folder, claimKeylessApp: true }).catch(
        (caught: unknown) => caught,
      );

      expect(error).toBe(networkError);
      expect(captured.err).toContain(TEMPORARY);
      expect(mockSearch).not.toHaveBeenCalled();
      expect(await breadcrumbExists()).toBe(true);
    });

    test.each(["agent", "human"])(
      "%s mode: a managed workspace stops with the API's code and says to switch workspaces",
      async (mode) => {
        mockIsAgent.mockReturnValue(mode === "agent");
        mockGetToken.mockResolvedValue("token");
        const body = JSON.stringify({
          errors: [
            {
              code: "accountless_application_managed_workspace",
              message: "Cannot claim into a managed workspace",
              long_message: "This workspace is managed by Vercel.",
            },
          ],
        });
        mockClaimApplication.mockRejectedValue(new PlapiError(403, body));

        const error = await runLink({ cwd: folder, claimKeylessApp: true }).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(PlapiError);
        expect((error as PlapiError).code).toBe("accountless_application_managed_workspace");
        expect((error as PlapiError).context).toBe(
          "Unable to claim - This workspace is managed by Vercel. Switch to a workspace you own and rerun `clerk link`, " +
            "or run `clerk link --app <app_id>` to link a different application",
        );
        expect(captured.err).not.toContain("Switch to a workspace");
        expect(mockSearch).not.toHaveBeenCalled();
        expect(await breadcrumbExists()).toBe(true);
      },
    );

    test("a claimed app with no development instance ends in the usual error, not a picker", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      const noDevApp = {
        application_id: "app_claimed",
        name: "My Init App",
        instances: [{ instance_id: "ins_prod", environment_type: "production" }],
      };
      mockClaimApplication.mockResolvedValue(noDevApp);
      mockLinkApp.mockResolvedValue(undefined);

      const error = await runLink({ cwd: folder, claimKeylessApp: true }).catch(
        (caught: unknown) => caught,
      );

      expect((error as CliError).code).toBe(ERROR_CODE.INSTANCE_NOT_FOUND);
      expect((error as CliError).message).toBe("Application has no development instance");
      expect(captured.err).toContain("Claimed application: `My Init App`");
      expect(captured.err).not.toContain("Claimed and linked");
      expect(mockAutolink).not.toHaveBeenCalled();
      expect(mockSetProfile).not.toHaveBeenCalled();
    });

    test("a failed link write is retried by linking the claimed app directly", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockClaimApplication.mockResolvedValue(claimedApp);
      mockLinkApp.mockRejectedValue(new Error("config busy"));

      await runLink({ cwd: folder, claimKeylessApp: true });

      expect(mockSetProfile).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ appId: "app_claimed", instances: { development: "ins_dev" } }),
      );
      expect(captured.err).toContain("Claimed application: `My Init App`");
      expect(captured.err).toContain("Linked to");
      expect(mockPull).not.toHaveBeenCalled();
      expect(mockAutolink).not.toHaveBeenCalled();
    });

    test("a config write that keeps failing reports its own error", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockClaimApplication.mockResolvedValue(claimedApp);
      mockLinkApp.mockRejectedValue(new Error("EACCES: config.json"));
      mockSetProfile.mockRejectedValue(new Error("EACCES: config.json"));

      await expect(runLink({ cwd: folder, claimKeylessApp: true })).rejects.toThrow(
        "EACCES: config.json",
      );
      expect(captured.err).not.toContain("Claimed and linked");
    });

    test("with CLERK_PLATFORM_API_KEY set, claims once without signing in", async () => {
      process.env.CLERK_PLATFORM_API_KEY = "ak_test";
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue(null);
      mockClaimApplication.mockResolvedValue(claimedApp);

      await runLink({ cwd: folder, claimKeylessApp: true });

      expect(mockLogin).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockClaimApplication).toHaveBeenCalledTimes(1);
      expect(mockLinkApp).toHaveBeenCalledWith(claimedApp, folder);
    });

    test("human mode: a spent token warns and falls through to the picker", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockClaimApplication.mockRejectedValue(new PlapiError(404, "Not Found"));
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("app_123");

      await runLink({ cwd: folder, claimKeylessApp: true });

      expect(captured.err).toContain(
        "Claim token is no longer valid - the application may have been claimed from the dashboard.",
      );
      expect(mockSearch).toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ appId: "app_123" }),
      );
      expect(mockLinkApp).not.toHaveBeenCalled();
    });

    test.each(["agent", "human"])(
      "%s mode: a key for another app stops with key_pair_mismatch and changes nothing",
      async (mode) => {
        mockIsAgent.mockReturnValue(mode === "agent");
        mockGetToken.mockResolvedValue("token");
        mockClaimApplication.mockResolvedValue(claimedApp);
        mockFindClerkKeys.mockResolvedValue([{ key: "pk_test_other", source: ".env" }]);
        const envPath = join(folder, ".env");
        const before = "CLERK_PUBLISHABLE_KEY=pk_test_other\nCLERK_SECRET_KEY=sk_test_other\n";
        await Bun.write(envPath, before);

        const error = await runLink({ cwd: folder, claimKeylessApp: true }).catch(
          (caught: unknown) => caught,
        );

        expect(error).toBeInstanceOf(CliError);
        expect((error as CliError).code).toBe(ERROR_CODE.KEY_PAIR_MISMATCH);
        expect((error as CliError).exitCode).toBe(EXIT_CODE.GENERAL);
        expect((error as CliError).message).toBe(
          "Claimed application `My Init App` (app_claimed) into your account, but .env holds a publishable key for a different application, " +
            "so this folder wasn't linked and its keys weren't changed. " +
            "Run `clerk link --app <app_id>` with the application this folder should use.",
        );
        expect(mockLinkApp).not.toHaveBeenCalled();
        expect(mockPull).not.toHaveBeenCalled();
        expect(mockSetProfile).not.toHaveBeenCalled();
        expect(await Bun.file(envPath).text()).toBe(before);
        expect(await breadcrumbExists()).toBe(false);
      },
    );

    test("--app skips the claim and links the named app", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);

      await runLink({ cwd: folder, app: "app_123", claimKeylessApp: true });

      expect(mockClaimApplication).not.toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
      expect(await breadcrumbExists()).toBe(true);
    });

    test("signed out, --app leaves claiming to sign-in, as before", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue(null);
      mockLogin.mockResolvedValue({ email: "a@b.c" });
      mockFetchApplication.mockResolvedValue(mockApp);

      await runLink({ cwd: folder, app: "app_123", claimKeylessApp: true });

      // Sign-in with its default claim; link's own claim step doesn't run.
      expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false });
      expect(mockClaimApplication).not.toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ appId: "app_123" }),
      );
    });

    test("signed out, relinking an already linked folder leaves claiming to sign-in, as before", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue(null);
      mockLogin.mockResolvedValue({ email: "a@b.c" });
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });
      mockConfirm.mockResolvedValue(true);
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("app_123");

      await runLink({ cwd: folder, claimKeylessApp: true });

      expect(mockLogin).toHaveBeenCalledWith({ showNextSteps: false });
      expect(mockClaimApplication).not.toHaveBeenCalled();
      expect(mockSetProfile).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ appId: "app_123" }),
      );
    });

    test("an existing link skips the claim", async () => {
      mockIsAgent.mockReturnValue(true);
      mockResolveProfile.mockResolvedValue({
        path: "/repo/.git",
        profile: { workspaceId: "", appId: "app_existing", instances: { development: "ins_1" } },
      });

      await runLink({ cwd: folder, claimKeylessApp: true });

      expect(mockClaimApplication).not.toHaveBeenCalled();
      expect(captured.err).toContain("Already linked");
      expect(await breadcrumbExists()).toBe(true);
    });

    test("clerk init's call (skipIfLinked, createIfMissing) never claims", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockCreateApplication.mockResolvedValue(mockApp);

      await runLink({ cwd: folder, skipIfLinked: true, createIfMissing: "my-app" });

      expect(mockClaimApplication).not.toHaveBeenCalled();
      expect(mockCreateApplication).toHaveBeenCalledWith("my-app");
      expect(await breadcrumbExists()).toBe(true);
    });

    test("clerk doctor's and clerk migrate's calls never claim", async () => {
      mockIsAgent.mockReturnValue(true);

      await expect(runLink({ cwd: folder })).rejects.toThrow(
        "Cannot select an application in agent mode",
      );
      await runLink({ cwd: folder, skipIfLinked: true }).catch(() => {});

      expect(mockClaimApplication).not.toHaveBeenCalled();
      expect(await breadcrumbExists()).toBe(true);
    });

    test("the clerk link command itself claims", async () => {
      mockIsAgent.mockReturnValue(true);
      mockGetToken.mockResolvedValue("token");
      mockClaimApplication.mockResolvedValue(claimedApp);
      const cwdSpy = spyOn(process, "cwd").mockReturnValue(folder);
      const program = new Command();
      registerLink(program as never);

      try {
        await program.parseAsync(["link"], { from: "user" });
      } finally {
        cwdSpy.mockRestore();
      }

      expect(mockClaimApplication).toHaveBeenCalledWith("tok_init", expect.any(String));
      expect(mockLinkApp).toHaveBeenCalledWith(claimedApp, folder);
    });
  });

  describe("create app from picker", () => {
    test("selecting create option prompts for name and creates app", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("__create_new__");
      mockInput.mockResolvedValue("Brand New App");
      mockCreateApplication.mockResolvedValue({
        application_id: "app_new",
        name: "Brand New App",
        instances: [],
      });
      mockFetchApplication.mockResolvedValue({
        application_id: "app_new",
        name: "Brand New App",
        instances: [
          {
            instance_id: "ins_dev_new",
            environment_type: "development",
            publishable_key: "pk_test_new",
          },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(mockInput).toHaveBeenCalledWith(
        expect.objectContaining({ message: "Application name:", validate: expect.any(Function) }),
      );
      expect(mockCreateApplication).toHaveBeenCalledWith("Brand New App");
      expect(mockFetchApplication).toHaveBeenCalledWith("app_new");
      expect(mockSetProfile).toHaveBeenCalledWith(
        "github.com/org/repo",
        expect.objectContaining({ appId: "app_new", appName: "Brand New App" }),
      );
    });

    test("trims whitespace from app name", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("__create_new__");
      mockInput.mockResolvedValue("  Spaced Name  ");
      mockCreateApplication.mockResolvedValue({
        application_id: "app_trimmed",
        name: "Spaced Name",
        instances: [],
      });
      mockFetchApplication.mockResolvedValue({
        application_id: "app_trimmed",
        name: "Spaced Name",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test" },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(mockCreateApplication).toHaveBeenCalledWith("Spaced Name");
    });

    test("validate callback rejects empty app name", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("__create_new__");

      let capturedValidate: ((v: string) => true | string) | undefined;
      mockInput.mockImplementation(
        async (config: { message: string; validate?: (v: string) => true | string }) => {
          capturedValidate = config.validate;
          return "Valid App";
        },
      );
      mockCreateApplication.mockResolvedValue({
        application_id: "app_v",
        name: "Valid App",
        instances: [],
      });
      mockFetchApplication.mockResolvedValue({
        application_id: "app_v",
        name: "Valid App",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test" },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(capturedValidate).toBeDefined();
      expect(capturedValidate!("")).toBe("Application name cannot be empty");
      expect(capturedValidate!("   ")).toBe("Application name cannot be empty");
      expect(capturedValidate!("My App")).toBeUndefined();
    });

    test("propagates createApplication failure without linking", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("__create_new__");
      mockInput.mockResolvedValue("My App");
      mockCreateApplication.mockRejectedValue(PlapiError.fromBody(422, "Unprocessable Entity"));

      await expect(link()).rejects.toBeInstanceOf(PlapiError);
      expect(mockSetProfile).not.toHaveBeenCalled();
    });

    test("propagates fetchApplication failure after create without linking", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("__create_new__");
      mockInput.mockResolvedValue("My App");
      mockCreateApplication.mockResolvedValue({
        application_id: "app_new",
        name: "My App",
        instances: [],
      });
      mockFetchApplication.mockRejectedValue(PlapiError.fromBody(503, "Service Unavailable"));

      await expect(link()).rejects.toBeInstanceOf(PlapiError);
      expect(mockSetProfile).not.toHaveBeenCalled();
    });

    test("logs creation message", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("__create_new__");
      mockInput.mockResolvedValue("Created App");
      mockCreateApplication.mockResolvedValue({
        application_id: "app_c",
        name: "Created App",
        instances: [],
      });
      mockFetchApplication.mockResolvedValue({
        application_id: "app_c",
        name: "Created App",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk_test" },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(captured.err).toContain("Created");
      expect(captured.err).toContain("Created App");
    });
  });
});

describe("replacedLink", () => {
  afterEach(() => {
    mockResolveProfile.mockReset();
    mockGetGitRepoRoot.mockReset();
  });

  function linked(path: string, appId = "app_A", appName = "Web") {
    mockResolveProfile.mockResolvedValue({
      path,
      profile: { appId, appName },
      resolvedVia: "remote",
    });
  }

  test("names the repository-wide link another app would replace", async () => {
    linked("github.com/acme/web");
    mockGetGitRepoRoot.mockResolvedValue("/repo");

    expect(await replacedLink("/repo/apps/ios", "app_B")).toEqual({
      appId: "app_A",
      appName: "Web",
      scope: "/repo",
    });
  });

  test("a new project inside the repository replaces it too", async () => {
    linked("/repo/.git");
    mockGetGitRepoRoot.mockResolvedValue("/repo");

    expect(await replacedLink("/repo", "app_B", { newProject: true })).toMatchObject({
      scope: "/repo",
    });
  });

  test.each([
    { name: "no link", setup: () => mockResolveProfile.mockResolvedValue(undefined) },
    { name: "the same app", setup: () => linked("github.com/acme/web", "app_B") },
  ])("keeps $name", async ({ setup }) => {
    setup();
    mockGetGitRepoRoot.mockResolvedValue("/repo");

    expect(await replacedLink("/repo", "app_B")).toBeUndefined();
  });

  test("outside a repository, only a link stored for the folder itself is replaced", async () => {
    mockGetGitRepoRoot.mockResolvedValue(undefined);

    linked("/work");
    expect(await replacedLink("/work", "app_B")).toEqual({
      appId: "app_A",
      appName: "Web",
      scope: "/work",
    });
    // A parent's link is inherited, not overwritten: the folder gets a link of its own.
    expect(await replacedLink("/work/ios", "app_B")).toBeUndefined();
    expect(await replacedLink("/work", "app_B", { newProject: true })).toBeUndefined();
  });
});
