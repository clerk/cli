import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { createConfig, resolveInstanceId, _setConfigDir, type Profile } from "./config.ts";
import type { Environment } from "./environment.ts";
import type { Plapi } from "./plapi.ts";
import type { Git } from "./git.ts";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const fakeEnv: Environment = {
  setCurrentEnv: () => {},
  getCurrentEnvName: () => "production",
  getCurrentEnv: () => ({
    oauthClientId: "",
    oauthBaseUrl: "",
    platformApiUrl: "https://api.test",
    backendApiUrl: "https://api.test.dev",
  }),
  getAvailableEnvs: () => ["production"],
  isValidEnv: () => true,
  getOAuthConfig: () => ({
    clientId: "",
    scopes: "",
    authorizeUrl: "",
    tokenUrl: "",
    userinfoUrl: "",
  }),
  getPlapiBaseUrl: () => "https://api.test",
  getBapiBaseUrl: () => "https://api.test.dev",
  getDashboardUrl: () => "https://dashboard.test",
  getPlatformApiKey: () => undefined,
};

const unusedPlapi: Plapi = new Proxy({} as Plapi, {
  get(_target, prop: string) {
    return () => {
      throw new Error(`plapi.${prop} called unexpectedly in config.test.ts`);
    };
  },
});

// Empty-git fake: resolveProfile tests don't exercise remote/repo-id matching,
// so every method returns undefined. The walk-up-directories path is what the
// tests assert on.
const fakeGit: Git = {
  getGitRepoRoot: async () => undefined,
  getGitRepoIdentifier: async () => undefined,
  getGitNormalizedRemote: async () => undefined,
  normalizeGitRemoteUrl: (url: string) => url,
};

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
  resolveAppContext,
} = createConfig(fakeEnv, unusedPlapi, fakeGit);

describe("config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-test-"));
    _setConfigDir(tempDir);
  });

  afterEach(async () => {
    _setConfigDir(undefined);
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
  });
});
