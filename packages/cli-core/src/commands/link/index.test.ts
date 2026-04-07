import { test, expect, describe, beforeEach, mock } from "bun:test";
import type { Application } from "../../lib/plapi.ts";

// `lib/autolink.ts` is imported directly by `link/index.ts` (it's a pure-ish
// helper, not in the deps registry per the deps-injection design). To keep
// the tests for the "autolink from detected keys" branch working without
// touching real `.env` files, mock the module at file top before importing
// the command. Bun tests run each file in its own subprocess, so this
// registration does not leak to other test files.
const mockAutolink = mock();
const mockFindClerkKeys = mock();
const mockMatchKeyToApp = mock();
mock.module("../../lib/autolink.ts", () => ({
  autolink: (...args: unknown[]) => mockAutolink(...args),
  findClerkKeys: (...args: unknown[]) => mockFindClerkKeys(...args),
  matchKeyToApp: (...args: unknown[]) => mockMatchKeyToApp(...args),
}));

const { link } = await import("./index.ts");
const { testRoot } = await import("../../test/lib/test-root.ts");

const MOCK_APP: Application = {
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

const HUMAN = { isAgent: () => false, isHuman: () => true } as const;

/**
 * Build a deps fixture pre-wired for the common "first-time link" happy
 * path. Tests can override individual slices.
 */
function happyDeps(overrides?: Parameters<typeof testRoot>[0]) {
  return testRoot({
    mode: HUMAN,
    env: { get: () => "platform_key" }, // CLERK_PLATFORM_API_KEY present, skip auth
    git: {
      getGitRepoRoot: async () => "/repo",
      getGitNormalizedRemote: async () => "github.com/org/repo",
      getGitRepoIdentifier: async () => "/repo/.git",
    },
    configStore: {
      resolveProfile: async () => undefined,
      setProfile: async () => {},
      moveProfile: async () => {},
    },
    plapi: {
      fetchApplication: async () => MOCK_APP,
      listApplications: async () => [MOCK_APP],
    },
    ...overrides,
  });
}

describe("link", () => {
  beforeEach(() => {
    mockAutolink.mockReset();
    mockAutolink.mockResolvedValue(undefined);
    mockFindClerkKeys.mockReset();
    mockFindClerkKeys.mockResolvedValue([]);
    mockMatchKeyToApp.mockReset();
    mockMatchKeyToApp.mockReturnValue(undefined);
  });

  describe("agent mode", () => {
    test("outputs prompt and returns without interactive prompts", async () => {
      const deps = testRoot({
        mode: { isAgent: () => true, isHuman: () => false },
        plapi: { listApplications: async () => [] },
      });

      await link(deps);

      expect(deps.log.data).toHaveBeenCalledTimes(1);
      const output = (deps.log.data as ReturnType<typeof mock>).mock.calls[0]![0] as string;
      expect(output).toContain("linking a Clerk application");
      expect(deps.prompts.search).not.toHaveBeenCalled();
      expect(deps.credentialStore.getToken).not.toHaveBeenCalled();
      expect(deps.plapi.listApplications).not.toHaveBeenCalled();
    });
  });

  describe("already linked", () => {
    test("notifies and returns when user declines re-link", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "/repo/.git",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
        },
        prompts: { confirm: async () => false },
      });

      await link(deps);

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Already linked") && m.includes("app_existing"))).toBe(
        true,
      );
      expect(deps.prompts.confirm).toHaveBeenCalled();
      expect(deps.credentialStore.getToken).not.toHaveBeenCalled();
      expect(deps.plapi.listApplications).not.toHaveBeenCalled();
    });

    test("proceeds with re-link when user confirms", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "/repo/.git",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
          setProfile: async () => {},
        },
        prompts: { confirm: async () => true },
      });

      await link(deps, { app: "app_123" });

      expect(deps.prompts.confirm).toHaveBeenCalled();
      expect(deps.configStore.setProfile).toHaveBeenCalled();
    });
  });

  describe("skipIfLinked", () => {
    test("returns early when linked and no --app given", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "/repo/.git",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
        },
      });

      await link(deps, { skipIfLinked: true });

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Already linked"))).toBe(true);
      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.plapi.fetchApplication).not.toHaveBeenCalled();
      expect(deps.configStore.setProfile).not.toHaveBeenCalled();
    });

    test("returns early when linked to the same app as --app", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "/repo/.git",
            profile: {
              workspaceId: "",
              appId: "app_123",
              instances: { development: "ins_1" },
            },
          }),
        },
      });

      await link(deps, { skipIfLinked: true, app: "app_123" });

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Already linked"))).toBe(true);
      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.plapi.fetchApplication).not.toHaveBeenCalled();
      expect(deps.configStore.setProfile).not.toHaveBeenCalled();
    });

    test("falls through to re-link prompt when --app differs from existing link", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "/repo/.git",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
          setProfile: async () => {},
        },
        prompts: { confirm: async () => true },
      });

      await link(deps, { skipIfLinked: true, app: "app_123" });

      expect(deps.prompts.confirm).toHaveBeenCalled();
      expect(deps.plapi.fetchApplication).toHaveBeenCalledWith("app_123");
      expect(deps.configStore.setProfile).toHaveBeenCalled();
    });
  });

  describe("authentication", () => {
    test("invokes login when no token exists and no platform key", async () => {
      const deps = happyDeps({
        env: { get: () => undefined },
        credentialStore: {
          getToken: async () => null,
          storeToken: async () => {},
        },
        configStore: {
          resolveProfile: async () => undefined,
          setProfile: async () => {},
          moveProfile: async () => {},
          setAuth: async () => {},
        },
        tokenExchange: {
          exchangeCodeForToken: async () => ({
            access_token: "tok",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          fetchUserInfo: async () => ({ userId: "u", email: "e@x" }),
        },
        authServer: {
          startAuthServer: () => ({
            port: 1,
            waitForCallback: async () => ({ code: "c" }),
            stop: () => {},
          }),
        },
        browser: { open: async () => ({ ok: true }) },
        environment: {
          getOAuthConfig: () => ({
            clientId: "test-client",
            scopes: "openid",
            authorizeUrl: "https://accounts.test/oauth/authorize",
            tokenUrl: "https://accounts.test/oauth/token",
            userinfoUrl: "https://accounts.test/oauth/userinfo",
          }),
        },
      });

      await link(deps, { app: "app_123" });

      expect(deps.authServer.startAuthServer).toHaveBeenCalled();
    });

    test("skips login when CLERK_PLATFORM_API_KEY is set", async () => {
      const deps = happyDeps({
        env: { get: (name: string) => (name === "CLERK_PLATFORM_API_KEY" ? "k" : undefined) },
      });

      await link(deps, { app: "app_123" });

      expect(deps.credentialStore.getToken).not.toHaveBeenCalled();
      expect(deps.authServer.startAuthServer).not.toHaveBeenCalled();
    });

    test("skips login when token exists", async () => {
      const deps = happyDeps({
        env: { get: () => undefined },
        credentialStore: { getToken: async () => "oauth_token" },
      });

      await link(deps, { app: "app_123" });

      expect(deps.credentialStore.getToken).toHaveBeenCalled();
      expect(deps.authServer.startAuthServer).not.toHaveBeenCalled();
    });
  });

  describe("app selection", () => {
    test("uses --app flag to skip picker", async () => {
      const deps = happyDeps();

      await link(deps, { app: "app_123" });

      expect(deps.plapi.listApplications).not.toHaveBeenCalled();
      expect(deps.prompts.search).not.toHaveBeenCalled();
      expect(deps.plapi.fetchApplication).toHaveBeenCalledWith("app_123");
    });

    test("shows interactive picker when no --app flag", async () => {
      const apps: Application[] = [
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
      ];
      const deps = happyDeps({
        plapi: { fetchApplication: async () => MOCK_APP, listApplications: async () => apps },
        prompts: { search: async () => "app_a" },
      });

      await link(deps);

      expect(deps.plapi.listApplications).toHaveBeenCalled();
      expect(deps.prompts.search).toHaveBeenCalled();
      expect(deps.plapi.fetchApplication).not.toHaveBeenCalled();
    });

    test("source returns all choices when term is empty", async () => {
      const apps: Application[] = [
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
      ];
      const search = mock(async (config: { source: (term: string | undefined) => unknown[] }) => {
        const results = config.source(undefined);
        // 2 apps + the "Create a new application" option appended by pickOrCreateApp
        expect(results).toHaveLength(3);
        return "app_a";
      });
      const deps = happyDeps({
        plapi: { fetchApplication: async () => MOCK_APP, listApplications: async () => apps },
        prompts: { search },
      });

      await link(deps);
    });

    test("source filters choices by name substring (case-insensitive)", async () => {
      const apps: Application[] = [
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
      ];
      const search = mock(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          // Filter results plus the appended create-new option (pickOrCreateApp).
          const results = config.source("my");
          expect(results).toHaveLength(2);
          expect(results[0]!.value).toBe("app_a");
          const noMatch = config.source("zzz");
          expect(noMatch).toHaveLength(1); // only the create-new option remains
          return "app_a";
        },
      );
      const deps = happyDeps({
        plapi: { fetchApplication: async () => MOCK_APP, listApplications: async () => apps },
        prompts: { search },
      });

      await link(deps);
    });

    test("source filters by app ID when name is absent", async () => {
      const apps: Application[] = [
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
      ];
      const search = mock(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          // Filter match plus the appended create-new option (pickOrCreateApp).
          const results = config.source("abc");
          expect(results).toHaveLength(2);
          expect(results[0]!.value).toBe("app_abc");
          return "app_abc";
        },
      );
      const deps = happyDeps({
        plapi: { fetchApplication: async () => MOCK_APP, listApplications: async () => apps },
        prompts: { search },
      });

      await link(deps);
    });

    test("empty app list still shows picker with just the create-new option", async () => {
      // Behaviour change from pickApp -> pickOrCreateApp: an empty list is
      // no longer a hard error. The picker shows only the "Create a new
      // application" option, letting users create an app without leaving
      // the CLI (PR #96).
      const search = mock(
        async (config: {
          source: (term: string | undefined) => { name: string; value: string }[];
        }) => {
          const results = config.source(undefined);
          expect(results).toHaveLength(1);
          // Return the create sentinel; callers then prompt for a name.
          return results[0]!.value;
        },
      );
      const input = mock(async () => "New App");
      const createApplication = mock(async () => MOCK_APP);
      const fetchApplication = mock(async () => MOCK_APP);
      const deps = happyDeps({
        plapi: { listApplications: async () => [], createApplication, fetchApplication },
        prompts: { search, input },
      });

      await link(deps);

      expect(createApplication).toHaveBeenCalledWith("New App");
      expect(fetchApplication).toHaveBeenCalled();
    });
  });

  describe("profile storage", () => {
    test("stores profile keyed by normalized remote URL", async () => {
      const deps = happyDeps();

      await link(deps, { app: "app_123" });

      expect(deps.configStore.setProfile).toHaveBeenCalledWith("github.com/org/repo", {
        workspaceId: "",
        appId: "app_123",
        instances: { development: "ins_dev", production: "ins_prod" },
      });
    });

    test("falls back to git repo identifier when no remote", async () => {
      const deps = happyDeps({
        git: {
          getGitRepoRoot: async () => "/repo",
          getGitNormalizedRemote: async () => undefined,
          getGitRepoIdentifier: async () => "/repo/.git",
        },
      });

      await link(deps, { app: "app_123" });

      expect(deps.configStore.setProfile).toHaveBeenCalledWith("/repo/.git", {
        workspaceId: "",
        appId: "app_123",
        instances: { development: "ins_dev", production: "ins_prod" },
      });
    });

    test("falls back to cwd when not in a git repo", async () => {
      const deps = happyDeps({
        git: {
          getGitRepoRoot: async () => undefined,
          getGitNormalizedRemote: async () => undefined,
          getGitRepoIdentifier: async () => undefined,
        },
      });

      await link(deps, { app: "app_123" });

      expect(deps.configStore.setProfile).toHaveBeenCalledWith(process.cwd(), {
        workspaceId: "",
        appId: "app_123",
        instances: { development: "ins_dev", production: "ins_prod" },
      });
    });

    test("omits production when not available", async () => {
      const devOnly: Application = {
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            secret_key: "sk_test",
            publishable_key: "pk_test",
          },
        ],
      };
      const deps = happyDeps({
        plapi: { fetchApplication: async () => devOnly, listApplications: async () => [devOnly] },
      });

      await link(deps, { app: "app_123" });

      const setCall = (deps.configStore.setProfile as ReturnType<typeof mock>).mock.calls[0];
      expect(
        (setCall![1] as { instances: Record<string, string> }).instances.production,
      ).toBeUndefined();
    });

    test("throws when no development instance", async () => {
      const prodOnly: Application = {
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_prod",
            environment_type: "production",
            secret_key: "sk_live",
            publishable_key: "pk_live",
          },
        ],
      };
      const deps = happyDeps({
        plapi: { fetchApplication: async () => prodOnly, listApplications: async () => [prodOnly] },
      });

      await expect(link(deps, { app: "app_123" })).rejects.toThrow(
        "Application has no development instance",
      );
    });

    test("logs confirmation message", async () => {
      const deps = happyDeps();

      await link(deps, { app: "app_123" });

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Linked to"))).toBe(true);
    });
  });

  describe("auto-link via remote", () => {
    test("prints auto-link notice when resolved via remote", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "github.com/org/repo",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
            resolvedVia: "remote",
          }),
        },
        prompts: { confirm: async () => false },
      });

      await link(deps);

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Auto-linked via git remote"))).toBe(true);
      expect(messages.some((m) => m.includes("github.com/org/repo"))).toBe(true);
    });

    test("skips silently with skipIfLinked after printing auto-link notice", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "github.com/org/repo",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
            resolvedVia: "remote",
          }),
        },
      });

      await link(deps, { skipIfLinked: true });

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Auto-linked via git remote"))).toBe(true);
      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.credentialStore.getToken).not.toHaveBeenCalled();
    });

    test("does not print auto-link notice when resolved via git-common-dir", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "/repo/.git",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
            resolvedVia: "git-common-dir",
          }),
        },
        prompts: { confirm: async () => false },
      });

      await link(deps);

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Auto-linked via git remote"))).toBe(false);
      expect(messages.some((m) => m.includes("Already linked"))).toBe(true);
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
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => dirProfile,
          moveProfile: async () => {},
        },
        prompts: { confirm: async () => true }, // accept upgrade
      });

      await link(deps);

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("git repository with remote"))).toBe(true);
      expect(messages.some((m) => m.includes("Link updated"))).toBe(true);
      expect(deps.configStore.moveProfile).toHaveBeenCalledWith(
        "/projects/myapp",
        "github.com/org/repo",
      );
    });

    test("falls through to re-link when upgrade is declined", async () => {
      const confirm = mock(async () => false);
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => dirProfile,
          moveProfile: async () => {},
        },
        prompts: { confirm },
      });

      await link(deps);

      expect(deps.configStore.moveProfile).not.toHaveBeenCalled();
      expect(deps.credentialStore.getToken).not.toHaveBeenCalled();
    });

    test("skips upgrade prompt with skipIfLinked", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => dirProfile,
          moveProfile: async () => {},
        },
      });

      await link(deps, { skipIfLinked: true });

      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.configStore.moveProfile).not.toHaveBeenCalled();
    });

    test("offers upgrade for git-common-dir profile with available remote", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            ...dirProfile,
            path: "/repo/.git",
            resolvedVia: "git-common-dir",
            availableRemote: "github.com/org/repo",
          }),
          moveProfile: async () => {},
        },
        prompts: { confirm: async () => true },
      });

      await link(deps);

      expect(deps.configStore.moveProfile).toHaveBeenCalledWith(
        "/repo/.git",
        "github.com/org/repo",
      );
    });
  });

  describe("autolink from detected keys", () => {
    test("suggests detected app and links when user confirms", async () => {
      mockFindClerkKeys.mockResolvedValue([
        { key: "pk_test", source: "CLERK_PUBLISHABLE_KEY env var" },
      ]);
      mockMatchKeyToApp.mockReturnValue({
        app: MOCK_APP,
        instance: MOCK_APP.instances[0],
        source: "CLERK_PUBLISHABLE_KEY env var",
      });
      const deps = happyDeps({
        prompts: { confirm: async () => true },
      });

      await link(deps);

      expect(mockFindClerkKeys).toHaveBeenCalled();
      expect(mockMatchKeyToApp).toHaveBeenCalled();
      expect(deps.prompts.confirm).toHaveBeenCalled();
      expect(deps.configStore.setProfile).toHaveBeenCalledWith("github.com/org/repo", {
        workspaceId: "",
        appId: "app_123",
        instances: { development: "ins_dev", production: "ins_prod" },
      });
      expect(deps.prompts.search).not.toHaveBeenCalled();
    });

    test("shows picker when user declines suggested app", async () => {
      const otherApp: Application = {
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
      mockFindClerkKeys.mockResolvedValue([
        { key: "pk_test", source: "CLERK_PUBLISHABLE_KEY env var" },
      ]);
      mockMatchKeyToApp.mockReturnValue({
        app: MOCK_APP,
        instance: MOCK_APP.instances[0],
        source: "CLERK_PUBLISHABLE_KEY env var",
      });
      const deps = happyDeps({
        plapi: {
          fetchApplication: async () => MOCK_APP,
          listApplications: async () => [MOCK_APP, otherApp],
        },
        prompts: { confirm: async () => false, search: async () => "app_other" },
      });

      await link(deps);

      expect(deps.prompts.search).toHaveBeenCalled();
      expect(deps.configStore.setProfile).toHaveBeenCalledWith(
        "github.com/org/repo",
        expect.objectContaining({ appId: "app_other" }),
      );
    });

    test("skips key detection when --app flag is provided", async () => {
      const deps = happyDeps();

      await link(deps, { app: "app_123" });

      expect(mockFindClerkKeys).not.toHaveBeenCalled();
      expect(mockMatchKeyToApp).not.toHaveBeenCalled();
    });

    test("returns silently with skipIfLinked when autolink succeeds", async () => {
      mockAutolink.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "", appId: "app_detected", instances: { development: "ins_1" } },
      });
      const deps = happyDeps();

      await link(deps, { skipIfLinked: true });

      expect(mockAutolink).toHaveBeenCalled();
      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.credentialStore.getToken).not.toHaveBeenCalled();
    });

    test("falls through to picker when no keys detected", async () => {
      mockFindClerkKeys.mockResolvedValue([]);
      const deps = happyDeps({
        prompts: { search: async () => "app_123" },
      });

      await link(deps);

      expect(mockFindClerkKeys).toHaveBeenCalled();
      expect(mockMatchKeyToApp).not.toHaveBeenCalled();
      expect(deps.prompts.search).toHaveBeenCalled();
    });

    test("falls through to picker when keys don't match any app", async () => {
      mockFindClerkKeys.mockResolvedValue([{ key: "sk_unknown", source: ".env" }]);
      mockMatchKeyToApp.mockReturnValue(undefined);
      const deps = happyDeps({
        prompts: { search: async () => "app_123" },
      });

      await link(deps);

      expect(mockMatchKeyToApp).toHaveBeenCalled();
      expect(deps.prompts.confirm).not.toHaveBeenCalled();
      expect(deps.prompts.search).toHaveBeenCalled();
    });

    test("still suggests key match on first-time link", async () => {
      mockFindClerkKeys.mockResolvedValue([
        { key: "pk_test", source: "CLERK_PUBLISHABLE_KEY env var" },
      ]);
      mockMatchKeyToApp.mockReturnValue({
        app: MOCK_APP,
        instance: MOCK_APP.instances[0],
        source: "CLERK_PUBLISHABLE_KEY env var",
      });
      const deps = happyDeps({
        prompts: { confirm: async () => true },
      });

      await link(deps);

      expect(mockFindClerkKeys).toHaveBeenCalled();
      expect(mockMatchKeyToApp).toHaveBeenCalled();
      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("We found"))).toBe(true);
    });
  });

  describe("re-link skips key detection", () => {
    test("skips key suggestion and shows picker when re-linking", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "github.com/org/repo",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
          setProfile: async () => {},
        },
        prompts: { confirm: async () => true, search: async () => "app_123" },
      });

      await link(deps);

      expect(deps.prompts.search).toHaveBeenCalled();
    });

    test("skips key suggestion when re-linking from auto-linked remote", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "github.com/org/repo",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
            resolvedVia: "remote",
          }),
          setProfile: async () => {},
        },
        prompts: { confirm: async () => true, search: async () => "app_123" },
      });

      await link(deps);

      const messages = (deps.log.info as ReturnType<typeof mock>).mock.calls.map(
        (c) => c[0] as string,
      );
      expect(messages.some((m) => m.includes("Auto-linked via git remote"))).toBe(true);
      expect(deps.prompts.search).toHaveBeenCalled();
    });

    test("skips key suggestion but respects --app flag when re-linking", async () => {
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "github.com/org/repo",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
          setProfile: async () => {},
        },
        prompts: { confirm: async () => true },
      });

      await link(deps, { app: "app_123" });

      expect(deps.prompts.search).not.toHaveBeenCalled();
      expect(deps.plapi.fetchApplication).toHaveBeenCalledWith("app_123");
    });

    test("shows target app name in re-link prompt when --app is provided", async () => {
      const namedApp: Application = { ...MOCK_APP, name: "My Cool App" };
      const confirmCalls: Array<{ message: string }> = [];
      const confirm = mock(async (config: { message: string; default?: boolean }) => {
        confirmCalls.push({ message: config.message });
        return true;
      });
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "github.com/org/repo",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
          setProfile: async () => {},
        },
        plapi: {
          fetchApplication: async () => namedApp,
          listApplications: async () => [namedApp],
        },
        prompts: { confirm },
      });

      await link(deps, { app: "app_123" });

      const reLinkPrompt = confirmCalls.find((c) => c.message.includes("Re-link"));
      expect(reLinkPrompt).toBeDefined();
      expect(reLinkPrompt!.message).toContain("My Cool App");
    });

    test("does not show app name in re-link prompt without --app", async () => {
      const confirmCalls: Array<{ message: string }> = [];
      const confirm = mock(async (config: { message: string; default?: boolean }) => {
        confirmCalls.push({ message: config.message });
        return true;
      });
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "github.com/org/repo",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
          }),
          setProfile: async () => {},
        },
        prompts: { confirm, search: async () => "app_123" },
      });

      await link(deps);

      const reLinkPrompt = confirmCalls.find((c) => c.message.includes("Re-link"));
      expect(reLinkPrompt).toBeDefined();
      expect(reLinkPrompt!.message).toBe("Re-link to a different application?");
    });

    test("skips key suggestion after declining profile upgrade", async () => {
      const confirmResponses = [false, true]; // decline upgrade, accept re-link
      let i = 0;
      const confirm = mock(async () => confirmResponses[i++]!);
      const deps = happyDeps({
        configStore: {
          resolveProfile: async () => ({
            path: "/repo/.git",
            profile: {
              workspaceId: "",
              appId: "app_existing",
              instances: { development: "ins_1" },
            },
            resolvedVia: "git-common-dir",
            availableRemote: "github.com/org/repo",
          }),
          setProfile: async () => {},
          moveProfile: async () => {},
        },
        prompts: { confirm, search: async () => "app_123" },
      });

      await link(deps);

      expect(deps.prompts.search).toHaveBeenCalled();
    });
  });
});
