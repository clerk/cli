import { test, expect, describe, afterEach, mock, spyOn } from "bun:test";

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
}));

const mockGetToken = mock();
mock.module("../../lib/credential-store.ts", () => ({
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

const mockLogin = mock();
mock.module("../auth/login.ts", () => ({
  login: (...args: unknown[]) => mockLogin(...args),
}));

const mockListApplications = mock();
const mockFetchApplication = mock();
mock.module("../../lib/plapi.ts", () => ({
  listApplications: (...args: unknown[]) => mockListApplications(...args),
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
}));

const mockSetProfile = mock();
const mockResolveProfile = mock();
const mockMoveProfile = mock();
mock.module("../../lib/config.ts", () => ({
  setProfile: (...args: unknown[]) => mockSetProfile(...args),
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
  moveProfile: (...args: unknown[]) => mockMoveProfile(...args),
}));

const mockGetGitRepoIdentifier = mock();
const mockGetGitRepoRoot = mock();
const mockGetGitNormalizedRemote = mock();
mock.module("../../lib/git.ts", () => ({
  getGitRepoIdentifier: (...args: unknown[]) => mockGetGitRepoIdentifier(...args),
  getGitRepoRoot: (...args: unknown[]) => mockGetGitRepoRoot(...args),
  getGitNormalizedRemote: (...args: unknown[]) => mockGetGitNormalizedRemote(...args),
}));

const mockSearch = mock();
const mockConfirm = mock();
mock.module("@inquirer/prompts", () => ({
  search: (...args: unknown[]) => mockSearch(...args),
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

const { link } = await import("./index.ts");

const mockApp = {
  application_id: "app_123",
  instances: [
    { instance_id: "ins_dev", environment_type: "development", secret_key: "sk_test", publishable_key: "pk_test" },
    { instance_id: "ins_prod", environment_type: "production", secret_key: "sk_live", publishable_key: "pk_live" },
  ],
};

function capturedOutput(spy: ReturnType<typeof spyOn>): string {
  return spy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
}

describe("link", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  afterEach(() => {
    mockIsAgent.mockReset();
    mockGetToken.mockReset();
    mockLogin.mockReset();
    mockListApplications.mockReset();
    mockFetchApplication.mockReset();
    mockSetProfile.mockReset();
    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue(undefined);
    mockMoveProfile.mockReset();
    mockGetGitRepoIdentifier.mockReset();
    mockGetGitRepoIdentifier.mockResolvedValue("/repo/.git");
    mockGetGitRepoRoot.mockReset();
    mockGetGitRepoRoot.mockResolvedValue("/repo");
    mockGetGitNormalizedRemote.mockReset();
    mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
    mockSearch.mockReset();
    mockConfirm.mockReset();
    consoleSpy?.mockRestore();
    errorSpy?.mockRestore();
    exitSpy?.mockRestore();
  });

  describe("agent mode", () => {
    test("outputs prompt and returns", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const output = consoleSpy.mock.calls[0][0] as string;
      expect(output).toContain("linking a Clerk application");
    });

    test("does not trigger interactive prompts", async () => {
      mockIsAgent.mockReturnValue(true);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
      expect(mockListApplications).not.toHaveBeenCalled();
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

      await link();

      const output = capturedOutput(consoleSpy);
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

      await link({ app: "app_123" });

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

      await link({ app: "app_123" });

      expect(mockLogin).toHaveBeenCalled();
    });

    test("skips login when token exists", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("oauth_token_123");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      expect(mockLogin).not.toHaveBeenCalled();
    });
  });

  describe("app selection", () => {
    test("uses --app flag to skip picker", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      expect(mockListApplications).not.toHaveBeenCalled();
      expect(mockSearch).not.toHaveBeenCalled();
      expect(mockFetchApplication).toHaveBeenCalledWith("app_123");
    });

    test("shows interactive picker when no --app flag", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        { application_id: "app_a", instances: [{ instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" }] },
        { application_id: "app_b", instances: [{ instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" }] },
      ]);
      mockSearch.mockResolvedValue("app_a");
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(mockListApplications).toHaveBeenCalled();
      expect(mockSearch).toHaveBeenCalled();
      expect(mockFetchApplication).not.toHaveBeenCalled();
    });

    test("source returns all choices when term is empty", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        { name: "My App", application_id: "app_a", instances: [{ instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" }] },
        { name: "Other App", application_id: "app_b", instances: [{ instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" }] },
      ]);
      mockSearch.mockImplementation(async (config: { source: (term: string | undefined) => unknown[] }) => {
        const results = config.source(undefined);
        expect(results).toHaveLength(2);
        return "app_a";
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();
    });

    test("source filters choices by name substring (case-insensitive)", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        { name: "My App", application_id: "app_a", instances: [{ instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" }] },
        { name: "Other App", application_id: "app_b", instances: [{ instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" }] },
      ]);
      mockSearch.mockImplementation(async (config: { source: (term: string | undefined) => { name: string; value: string }[] }) => {
        const results = config.source("my");
        expect(results).toHaveLength(1);
        expect(results[0]!.value).toBe("app_a");

        const noMatch = config.source("zzz");
        expect(noMatch).toHaveLength(0);

        return "app_a";
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();
    });

    test("source filters by app ID when name is absent", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([
        { application_id: "app_abc", instances: [{ instance_id: "ins_1", environment_type: "development", publishable_key: "pk_test" }] },
        { name: "Named", application_id: "app_xyz", instances: [{ instance_id: "ins_2", environment_type: "development", publishable_key: "pk_test2" }] },
      ]);
      mockSearch.mockImplementation(async (config: { source: (term: string | undefined) => { name: string; value: string }[] }) => {
        const results = config.source("abc");
        expect(results).toHaveLength(1);
        expect(results[0]!.value).toBe("app_abc");
        return "app_abc";
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();
    });

    test("exits when no apps found", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockListApplications.mockResolvedValue([]);
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
      exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

      await expect(link()).rejects.toThrow("exit");

      expect(errorSpy.mock.calls[0][0]).toContain("No applications found");
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

      await link({ app: "app_123" });

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

      await link({ app: "app_123" });

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

      await link({ app: "app_123" });

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
          { instance_id: "ins_dev", environment_type: "development", secret_key: "sk_test", publishable_key: "pk_test" },
        ],
      });
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      const storedProfile = mockSetProfile.mock.calls[0]![1];
      expect(storedProfile.instances.production).toBeUndefined();
    });

    test("exits when no development instance", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue({
        application_id: "app_123",
        instances: [
          { instance_id: "ins_prod", environment_type: "production", secret_key: "sk_live", publishable_key: "pk_live" },
        ],
      });
      errorSpy = spyOn(console, "error").mockImplementation(() => {});
      exitSpy = spyOn(process, "exit").mockImplementation(() => { throw new Error("exit"); });

      await expect(link({ app: "app_123" })).rejects.toThrow("exit");

      expect(errorSpy.mock.calls[0][0]).toContain("no development instance");
    });

    test("logs confirmation message", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetToken.mockResolvedValue("token");
      mockFetchApplication.mockResolvedValue(mockApp);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ app: "app_123" });

      const lastCall = consoleSpy.mock.calls[consoleSpy.mock.calls.length - 1][0] as string;
      expect(lastCall).toContain("Linked to");
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

      await link();

      const output = capturedOutput(consoleSpy);
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

      await link({ skipIfLinked: true });

      const output = capturedOutput(consoleSpy);
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

      await link();

      const output = capturedOutput(consoleSpy);
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

      await link();

      const output = capturedOutput(consoleSpy);
      expect(output).toContain("git repository with remote");
      expect(output).toContain("Link updated");
      expect(mockMoveProfile).toHaveBeenCalledWith("/projects/myapp", "github.com/org/repo");
    });

    test("falls through to re-link when upgrade is declined", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue(dirProfile);
      mockConfirm
        .mockResolvedValueOnce(false)  // decline upgrade
        .mockResolvedValueOnce(false); // decline re-link
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link();

      expect(mockMoveProfile).not.toHaveBeenCalled();
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    test("skips upgrade prompt with skipIfLinked", async () => {
      mockIsAgent.mockReturnValue(false);
      mockGetGitNormalizedRemote.mockResolvedValue("github.com/org/repo");
      mockResolveProfile.mockResolvedValue(dirProfile);
      consoleSpy = spyOn(console, "log").mockImplementation(() => {});

      await link({ skipIfLinked: true });

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

      await link();

      expect(mockMoveProfile).toHaveBeenCalledWith("/repo/.git", "github.com/org/repo");
    });
  });
});
