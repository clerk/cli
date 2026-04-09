import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  captureLog,
  configStubs,
  credentialStoreStubs,
  autolinkStubs,
  gitStubs,
  promptsStubs,
} from "../../test/lib/stubs.ts";
import { PlapiError } from "../../lib/errors.ts";

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
mock.module("../../lib/autolink.ts", () => ({
  ...autolinkStubs,
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
const mockConfirm = mock();
const mockInput = mock();
mock.module("@inquirer/prompts", () => ({
  ...promptsStubs,
  search: (...args: unknown[]) => mockSearch(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
  input: (...args: unknown[]) => mockInput(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  bar: () => {},
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { link } = await import("./index.ts");

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

describe("link", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    _modeOverride = undefined;
    mockIsAgent.mockReset();
    mockGetToken.mockReset();
    mockLogin.mockReset();
    mockListApplications.mockReset();
    mockFetchApplication.mockReset();
    mockCreateApplication.mockReset();
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
    mockConfirm.mockReset();
    mockInput.mockReset();
    consoleSpy?.mockRestore();
  });

  function runLink(options?: Parameters<typeof link>[0]) {
    return captured.run(() => link(options));
  }

  describe("agent mode", () => {
    test("outputs prompt and returns", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(captured.out).toContain("linking a Clerk application");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
    });

    test("prompt covers the create-app path", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await runLink();

      expect(captured.out).toContain("no applications exist");
      expect(captured.out).toContain("POST /v1/platform/applications");
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

    test("source returns all choices plus create option when term is empty", async () => {
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
        async (config: { source: (term: string | undefined) => unknown[] }) => {
          const results = config.source(undefined);
          expect(results).toHaveLength(3); // 2 apps + create option
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
          expect(results).toHaveLength(2); // 1 match + create option
          expect(results[0]!.value).toBe("app_a");
          expect(results[1]!.value).toBe("__create_new__");

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
          expect(results).toHaveLength(2); // 1 match + create option
          expect(results[0]!.value).toBe("app_abc");
          expect(results[1]!.value).toBe("__create_new__");
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
      mockListApplications.mockRejectedValue(new PlapiError(500, "Internal Server Error"));
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
      mockListApplications.mockRejectedValue(new PlapiError(401, "Unauthorized"));

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
      expect(capturedValidate!("My App")).toBe(true);
    });

    test("propagates createApplication failure without linking", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([mockApp]);
      mockSearch.mockResolvedValue("__create_new__");
      mockInput.mockResolvedValue("My App");
      mockCreateApplication.mockRejectedValue(new PlapiError(422, "Unprocessable Entity"));

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
      mockFetchApplication.mockRejectedValue(new PlapiError(503, "Service Unavailable"));

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
