import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { readConfig, writeConfig, getAuth, setAuth, clearAuth, getProfile, setProfile, listProfiles, resolveProfile, _setConfigDir } from "./config";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

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
      auth: { userId: "user_123" },
      profiles: {
        "/path/to/project": {
          workspaceId: "org_abc",
          appId: "app_def",
          instanceId: "ins_ghi",
        },
      },
    };
    await writeConfig(config);
    const result = await readConfig();
    expect(result).toEqual(config);
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
      instanceId: "ins_ghi",
    };
    await setProfile("/projects/my-app", profile);
    expect(await getProfile("/projects/my-app")).toEqual(profile);
    expect(await getProfile("/projects/other")).toBeUndefined();
  });

  test("listProfiles returns all profiles", async () => {
    await setProfile("/projects/app-a", {
      workspaceId: "org_1",
      appId: "app_1",
      instanceId: "ins_1",
    });
    await setProfile("/projects/app-b", {
      workspaceId: "org_2",
      appId: "app_2",
      instanceId: "ins_2",
    });
    const profiles = await listProfiles();
    expect(Object.keys(profiles)).toEqual(["/projects/app-a", "/projects/app-b"]);
  });

  test("resolveProfile finds exact match", async () => {
    await setProfile("/projects/my-app", {
      workspaceId: "org_1",
      appId: "app_1",
      instanceId: "ins_1",
    });
    const result = await resolveProfile("/projects/my-app");
    expect(result?.path).toBe("/projects/my-app");
    expect(result?.profile.appId).toBe("app_1");
  });

  test("resolveProfile walks up parent directories", async () => {
    await setProfile("/projects/my-app", {
      workspaceId: "org_1",
      appId: "app_1",
      instanceId: "ins_1",
    });
    const result = await resolveProfile("/projects/my-app/src/components");
    expect(result?.path).toBe("/projects/my-app");
  });

  test("resolveProfile returns undefined when no match", async () => {
    const result = await resolveProfile("/some/random/path");
    expect(result).toBeUndefined();
  });
});
