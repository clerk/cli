import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const {
  readConfig,
  writeConfig,
  getAuth,
  setAuth,
  clearAuth,
  getProfile,
  setProfile,
  listProfiles,
  resolveProfile,
  resolveInstanceId,
  resolveAppContext,
  resolveFetchedApplicationInstance,
  getActiveInstance,
  setActiveInstance,
  clearActiveInstance,
  resolveActiveKey,
  _setConfigDir,
} = await import("./config.ts");
type Profile =
  Awaited<ReturnType<typeof getProfile>> extends infer T ? Exclude<T, undefined> : never;
const plapiModule = await import("./plapi.ts");
const gitModule = await import("./git.ts");

describe("config", () => {
  let tempDir: string;
  let fetchApplicationSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-test-"));
    _setConfigDir(tempDir);
    fetchApplicationSpy = spyOn(plapiModule, "fetchApplication");
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    fetchApplicationSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("readConfig returns defaults when no file exists", async () => {
    const config = await readConfig();
    expect(config).toEqual({ profiles: {} });
  });

  test("writeConfig and readConfig roundtrip", async () => {
    const config = {
      auth: { production: { userId: "user_123" } },
      profiles: {
        "/path/to/project": {
          workspaceId: "org_abc",
          appId: "app_def",
          instances: { development: "ins_ghi" },
        },
      },
    };
    await writeConfig(config);
    const result = await readConfig();
    expect(result.auth).toEqual(config.auth);
    expect(result.profiles).toEqual(config.profiles);
  });

  test("readConfig migrates legacy auth format", async () => {
    // Write old-format config directly
    const legacyConfig = {
      auth: { userId: "user_legacy" },
      profiles: {},
    };
    await Bun.write(`${tempDir}/config.json`, JSON.stringify(legacyConfig));
    const result = await readConfig();
    expect(result.auth).toEqual({ production: { userId: "user_legacy" } });
  });

  test("setAuth and getAuth", async () => {
    expect(await getAuth()).toBeUndefined();
    await setAuth({ userId: "user_456" });
    expect(await getAuth()).toEqual({ userId: "user_456" });
  });

  test("clearAuth removes auth", async () => {
    await setAuth({ userId: "user_789" });
    await clearAuth();
    expect(await getAuth()).toBeUndefined();
  });

  test("setProfile and getProfile", async () => {
    const profile = {
      workspaceId: "org_abc",
      appId: "app_def",
      instances: { development: "ins_ghi" },
    };
    await setProfile("/projects/my-app", profile);
    expect(await getProfile("/projects/my-app")).toEqual(profile);
    expect(await getProfile("/projects/other")).toBeUndefined();
  });

  test("listProfiles returns all profiles", async () => {
    await setProfile("/projects/app-a", {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_1" },
    });
    await setProfile("/projects/app-b", {
      workspaceId: "org_2",
      appId: "app_2",
      instances: { development: "ins_2" },
    });
    const profiles = await listProfiles();
    expect(Object.keys(profiles)).toEqual(["/projects/app-a", "/projects/app-b"]);
  });

  test("resolveProfile finds exact match", async () => {
    await setProfile("/projects/my-app", {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_1" },
    });
    const result = await resolveProfile("/projects/my-app");
    expect(result?.path).toBe("/projects/my-app");
    expect(result?.profile.appId).toBe("app_1");
  });

  test("resolveProfile walks up parent directories", async () => {
    await setProfile("/projects/my-app", {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_1" },
    });
    const result = await resolveProfile("/projects/my-app/src/components");
    expect(result?.path).toBe("/projects/my-app");
  });

  test("resolveProfile returns undefined when no match", async () => {
    const result = await resolveProfile("/some/random/path");
    expect(result).toBeUndefined();
  });

  describe("resolveInstanceId", () => {
    const profile: Profile = {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    };

    test("defaults to development when no flag", () => {
      expect(resolveInstanceId(profile)).toEqual({ id: "ins_dev", label: "development" });
    });

    test("resolves dev alias", () => {
      expect(resolveInstanceId(profile, "dev")).toEqual({ id: "ins_dev", label: "development" });
    });

    test("resolves development alias", () => {
      expect(resolveInstanceId(profile, "development")).toEqual({
        id: "ins_dev",
        label: "development",
      });
    });

    test("resolves prod alias", () => {
      expect(resolveInstanceId(profile, "prod")).toEqual({ id: "ins_prod", label: "production" });
    });

    test("resolves production alias", () => {
      expect(resolveInstanceId(profile, "production")).toEqual({
        id: "ins_prod",
        label: "production",
      });
    });

    test("passes through literal instance ID", () => {
      expect(resolveInstanceId(profile, "ins_custom")).toEqual({
        id: "ins_custom",
        label: "ins_custom",
      });
    });

    test("throws when production not configured", () => {
      const devOnly: Profile = {
        workspaceId: "org_1",
        appId: "app_1",
        instances: { development: "ins_dev" },
      };
      expect(() => resolveInstanceId(devOnly, "prod")).toThrow("No production instance configured");
    });
  });

  describe("resolveAppContext (linked profile)", () => {
    test("uses appName as appLabel when available", async () => {
      const cwd = process.cwd();
      await setProfile(cwd, {
        workspaceId: "org_1",
        appId: "app_1",
        appName: "My Cool App",
        instances: { development: "ins_dev" },
      });

      const ctx = await resolveAppContext({});
      expect(ctx.appLabel).toBe("My Cool App");
      expect(ctx.appId).toBe("app_1");
    });

    test("falls back to appId when appName is not set", async () => {
      const cwd = process.cwd();
      await setProfile(cwd, {
        workspaceId: "org_1",
        appId: "app_1",
        instances: { development: "ins_dev" },
      });

      const ctx = await resolveAppContext({});
      expect(ctx.appLabel).toBe("app_1");
    });

    test("resolves via explicit cwd instead of process.cwd()", async () => {
      const projectDir = join(tempDir, "child-project");
      await setProfile(projectDir, {
        workspaceId: "org_1",
        appId: "app_in_child",
        instances: { development: "ins_dev" },
      });

      const ctx = await resolveAppContext({ cwd: projectDir });
      expect(ctx.appId).toBe("app_in_child");
    });
  });

  describe("resolveFetchedApplicationInstance", () => {
    const app = {
      application_id: "app_123",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_123",
        },
        {
          instance_id: "ins_custom_123",
          environment_type: "staging",
          publishable_key: "pk_test_custom_123",
        },
      ],
    };

    test("selects a literal existing instance id from fetched application data", () => {
      const result = resolveFetchedApplicationInstance("app_123", app, "ins_custom_123");

      expect(result).toMatchObject({
        found: true,
        instanceId: "ins_custom_123",
        instanceLabel: "staging",
      });
      if (result.found) {
        expect(result.instance.instance_id).toBe("ins_custom_123");
      }
    });

    test("labels a production instance targeted by literal id as production", () => {
      const prodApp = {
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_prod_123",
            environment_type: "production",
            publishable_key: "pk_live_123",
          },
        ],
      };

      const result = resolveFetchedApplicationInstance("app_123", prodApp, "ins_prod_123");

      expect(result).toMatchObject({
        found: true,
        instanceId: "ins_prod_123",
        instanceLabel: "production",
      });
    });

    test("selects the canonical development instance by default when branch instances are listed first", () => {
      const branchFirstApp = {
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_branch",
            environment_type: "development",
            publishable_key: "pk_test_branch",
            branch_name: "agent/pr-42",
          },
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_dev",
          },
        ],
      };

      const result = resolveFetchedApplicationInstance("app_123", branchFirstApp);

      expect(result).toMatchObject({
        found: true,
        instanceId: "ins_dev",
        instanceLabel: "development",
      });
    });

    test("excludes branch-linked instances even if branch_name is missing", () => {
      const branchLinkedApp = {
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_branch",
            environment_type: "development",
            publishable_key: "pk_test_branch",
            parent_instance_id: "ins_dev",
          },
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_dev",
          },
        ],
      };

      const result = resolveFetchedApplicationInstance("app_123", branchLinkedApp);

      expect(result).toMatchObject({
        found: true,
        instanceId: "ins_dev",
        instanceLabel: "development",
      });
    });

    test("selects the canonical development instance for dev aliases when branch instances are listed first", () => {
      const branchFirstApp = {
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_branch",
            environment_type: "development",
            publishable_key: "pk_test_branch",
            branch_name: "agent/pr-42",
          },
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk_test_dev",
          },
        ],
      };

      const result = resolveFetchedApplicationInstance("app_123", branchFirstApp, "dev");

      expect(result).toMatchObject({
        found: true,
        instanceId: "ins_dev",
        instanceLabel: "development",
      });
    });

    test("returns explicit missing state for unknown literal instance ids", () => {
      const result = resolveFetchedApplicationInstance("app_123", app, "ins_missing_123");

      expect(result).toEqual({
        found: false,
        instanceId: "ins_missing_123",
        instanceLabel: "ins_missing_123",
      });
    });

    test("matches a branch by name", () => {
      const branchApp = {
        application_id: "app_1",
        instances: [
          { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_live_x" },
          {
            instance_id: "ins_branch",
            environment_type: "development",
            publishable_key: "pk_test_y",
            branch_name: "agent/pr-42",
          },
        ],
      };

      const r = resolveFetchedApplicationInstance("app_1", branchApp, undefined, "agent/pr-42");
      expect(r.found).toBe(true);
      expect(r.instanceId).toBe("ins_branch");
      expect(r.instanceLabel).toBe("agent/pr-42");
    });

    test("throws INSTANCE_NOT_FOUND when branch name does not match any instance", () => {
      const branchApp = {
        application_id: "app_1",
        instances: [
          { instance_id: "ins_prod", environment_type: "production", publishable_key: "pk_live_x" },
        ],
      };

      expect(() =>
        resolveFetchedApplicationInstance("app_1", branchApp, undefined, "no-such-branch"),
      ).toThrow("No branch named");
    });

    test("raw branch instance id is labeled by branch name", () => {
      const branchApp = {
        application_id: "app_1",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk" },
          {
            instance_id: "ins_b",
            environment_type: "development",
            publishable_key: "pk",
            branch_name: "pr-9",
            parent_instance_id: "ins_dev",
          },
        ],
      };

      const result = resolveFetchedApplicationInstance("app_1", branchApp, "ins_b");

      expect(result.found).toBe(true);
      expect(result.instanceLabel).toBe("pr-9");
    });

    test("raw non-branch instance id is labeled by env", () => {
      const branchApp = {
        application_id: "app_1",
        instances: [
          { instance_id: "ins_dev", environment_type: "development", publishable_key: "pk" },
          {
            instance_id: "ins_b",
            environment_type: "development",
            publishable_key: "pk",
            branch_name: "pr-9",
            parent_instance_id: "ins_dev",
          },
        ],
      };

      const result = resolveFetchedApplicationInstance("app_1", branchApp, "ins_dev");

      expect(result.instanceLabel).toBe("development");
    });
  });

  describe("resolveAppContext (explicit app)", () => {
    test("resolves a literal existing instance id from fetched application data", async () => {
      fetchApplicationSpy.mockResolvedValue({
        application_id: "app_123",
        name: "My App",
        instances: [
          {
            instance_id: "ins_custom_123",
            environment_type: "staging",
            publishable_key: "pk_test_custom_123",
          },
        ],
      });

      await expect(
        resolveAppContext({ app: "app_123", instance: "ins_custom_123" }),
      ).resolves.toEqual({
        appId: "app_123",
        appLabel: "My App",
        instanceId: "ins_custom_123",
        instanceLabel: "staging",
        instanceSource: "flag",
      });
    });

    test("throws INSTANCE_NOT_FOUND when --instance does not match any fetched instance", async () => {
      fetchApplicationSpy.mockResolvedValue({
        application_id: "app_123",
        name: "My App",
        instances: [
          {
            instance_id: "ins_real_123",
            environment_type: "staging",
            publishable_key: "pk_test_real_123",
          },
        ],
      });

      await expect(
        resolveAppContext({ app: "app_123", instance: "ins_missing_123" }),
      ).rejects.toMatchObject({
        code: "instance_not_found",
      });
    });
  });

  describe("resolveAppContext (--branch and --instance mutual exclusivity)", () => {
    test("throws a usage error on the --app path when both are passed", async () => {
      await expect(
        resolveAppContext({ app: "app_123", branch: "agent/pr-42", instance: "dev" }),
      ).rejects.toMatchObject({
        code: "usage_error",
        message: "Cannot combine --branch and --instance. Pass only one to select an instance.",
      });
      // The guard runs before any application fetch.
      expect(fetchApplicationSpy).not.toHaveBeenCalled();
    });

    test("throws a usage error on the linked-profile path when both are passed", async () => {
      const cwd = process.cwd();
      await setProfile(cwd, {
        workspaceId: "org_1",
        appId: "app_1",
        instances: { development: "ins_dev" },
      });

      await expect(
        resolveAppContext({ branch: "agent/pr-42", instance: "dev" }),
      ).rejects.toMatchObject({
        code: "usage_error",
        message: "Cannot combine --branch and --instance. Pass only one to select an instance.",
      });
      expect(fetchApplicationSpy).not.toHaveBeenCalled();
    });
  });

  describe("active instance store", () => {
    test("set then get round-trips by explicit key", async () => {
      await setActiveInstance("/wt/app-pr-42", {
        appId: "app_1",
        instanceId: "ins_branch",
        label: "agent/pr-42",
        environmentType: "development",
      });
      const active = await getActiveInstance("/wt/app-pr-42");
      expect(active).toMatchObject({
        appId: "app_1",
        instanceId: "ins_branch",
        label: "agent/pr-42",
        environmentType: "development",
      });
    });

    test("keys are independent per worktree", async () => {
      await setActiveInstance("/wt/a", {
        appId: "app_1",
        instanceId: "ins_a",
        label: "dev",
        environmentType: "development",
      });
      await setActiveInstance("/wt/b", {
        appId: "app_1",
        instanceId: "ins_b",
        label: "agent/x",
        environmentType: "development",
      });
      expect((await getActiveInstance("/wt/a"))?.instanceId).toBe("ins_a");
      expect((await getActiveInstance("/wt/b"))?.instanceId).toBe("ins_b");
    });

    test("clear removes the entry", async () => {
      await setActiveInstance("/wt/a", {
        appId: "app_1",
        instanceId: "ins_a",
        label: "dev",
        environmentType: "development",
      });
      await clearActiveInstance("/wt/a");
      expect(await getActiveInstance("/wt/a")).toBeUndefined();
    });

    test("migration drops malformed active entries and keeps well-formed ones", async () => {
      const rawConfig = {
        profiles: {},
        active: {
          "/wt/good": {
            appId: "app_1",
            instanceId: "ins_good",
            label: "dev",
            environmentType: "development",
          },
          "/wt/missing-fields": { appId: "app_1" },
          "/wt/bad-env": {
            appId: "app_1",
            instanceId: "ins_bad",
            label: "dev",
            environmentType: "staging",
          },
        },
      };
      await Bun.write(`${tempDir}/config.json`, JSON.stringify(rawConfig));
      expect(await getActiveInstance("/wt/good")).toMatchObject({ instanceId: "ins_good" });
      expect(await getActiveInstance("/wt/missing-fields")).toBeUndefined();
      expect(await getActiveInstance("/wt/bad-env")).toBeUndefined();
    });

    test("resolveActiveKey uses the git worktree root when in a repo", async () => {
      const spy = spyOn(gitModule, "getGitRepoRoot").mockResolvedValue("/repo/root");
      try {
        expect(await resolveActiveKey("/repo/root/sub")).toBe("/repo/root");
      } finally {
        spy.mockRestore();
      }
    });

    test("resolveActiveKey falls back to cwd outside a git repo", async () => {
      const spy = spyOn(gitModule, "getGitRepoRoot").mockResolvedValue(undefined);
      try {
        expect(await resolveActiveKey("/some/cwd")).toBe("/some/cwd");
      } finally {
        spy.mockRestore();
      }
    });
  });

  describe("resolveAppContext honors persisted active instance", () => {
    test("no flag falls back to persisted active over development default", async () => {
      await setProfile("/repo", {
        workspaceId: "wsp_1",
        appId: "app_1",
        instances: { development: "ins_dev", production: "ins_prod" },
      });
      await setActiveInstance("/repo", {
        appId: "app_1",
        instanceId: "ins_branch",
        label: "agent/pr-42",
        environmentType: "development",
      });

      const ctx = await resolveAppContext({ cwd: "/repo" });
      expect(ctx.instanceId).toBe("ins_branch");
      expect(ctx.instanceLabel).toBe("agent/pr-42");
    });

    test("explicit --instance overrides persisted active", async () => {
      await setProfile("/repo", {
        workspaceId: "wsp_1",
        appId: "app_1",
        instances: { development: "ins_dev", production: "ins_prod" },
      });
      await setActiveInstance("/repo", {
        appId: "app_1",
        instanceId: "ins_branch",
        label: "agent/pr-42",
        environmentType: "development",
      });

      const ctx = await resolveAppContext({ cwd: "/repo", instance: "dev" });
      expect(ctx.instanceId).toBe("ins_dev");
      expect(ctx.instanceLabel).toBe("development");
    });

    test("stale cross-app active pointer is ignored", async () => {
      await setProfile("/repo", {
        workspaceId: "wsp_1",
        appId: "app_1",
        instances: { development: "ins_dev" },
      });
      await setActiveInstance("/repo", {
        appId: "app_OTHER",
        instanceId: "ins_x",
        label: "agent/x",
        environmentType: "development",
      });

      const ctx = await resolveAppContext({ cwd: "/repo" });
      expect(ctx.instanceId).toBe("ins_dev");
    });
  });
});
