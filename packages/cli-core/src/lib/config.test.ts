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
  _setConfigDir,
} = await import("./config.ts");
type Profile =
  Awaited<ReturnType<typeof getProfile>> extends infer T ? Exclude<T, undefined> : never;
const plapiModule = await import("./plapi.ts");

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

    test("returns explicit missing state for unknown literal instance ids", () => {
      const result = resolveFetchedApplicationInstance("app_123", app, "ins_missing_123");

      expect(result).toEqual({
        found: false,
        instanceId: "ins_missing_123",
        instanceLabel: "ins_missing_123",
      });
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
});
