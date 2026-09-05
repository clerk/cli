import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { setMode } from "../mode.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";
import { CliError, ERROR_CODE } from "./errors.ts";
import type { Application } from "./plapi.ts";

const mockFetchApplication = mock();
mock.module("./plapi.ts", () => ({
  fetchApplication: (...args: unknown[]) => mockFetchApplication(...args),
}));

const mockConfirm = mock();
mock.module("./prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
  text: async () => "",
  password: async () => "",
  editor: async () => "{}",
}));

const { setProfile, getProfile, resolveInstanceId, _setConfigDir } = await import("./config.ts");
const { recoverMissingInstance, refreshProfileInstances } = await import("./link-refresh.ts");

type Profile = NonNullable<Awaited<ReturnType<typeof getProfile>>>;

const DEV_ONLY: Profile = {
  workspaceId: "org_1",
  appId: "app_1",
  appName: "My App",
  instances: { development: "ins_dev" },
};

function application(instances: Application["instances"]): Application {
  return { application_id: "app_1", name: "My App", instances };
}

const DEV_INSTANCE = {
  instance_id: "ins_dev",
  environment_type: "development",
  publishable_key: "pk_test_1",
};
const PROD_INSTANCE = {
  instance_id: "ins_prod",
  environment_type: "production",
  publishable_key: "pk_live_1",
};

/** The error `resolveInstanceId` raises for a profile with no production id. */
function missOn(profile: Profile, flag: string): unknown {
  try {
    resolveInstanceId(profile, flag);
  } catch (error) {
    return error;
  }
  throw new Error("expected resolveInstanceId to throw");
}

describe("link-refresh", () => {
  let tempDir: string;
  useCaptureLog();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-link-refresh-"));
    _setConfigDir(tempDir);
    mockFetchApplication.mockReset();
    mockConfirm.mockReset();
    setMode("human");
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    setMode("human");
    await rm(tempDir, { recursive: true, force: true });
  });

  describe("refreshProfileInstances", () => {
    test("adds a production instance created after linking", async () => {
      await setProfile("key", DEV_ONLY);

      const result = await refreshProfileInstances(
        "key",
        DEV_ONLY,
        application([DEV_INSTANCE, PROD_INSTANCE]),
      );

      expect(result.updated).toEqual(["production"]);
      expect(result.profile.instances.production).toBe("ins_prod");
      expect((await getProfile("key"))?.instances.production).toBe("ins_prod");
    });

    test("reports no change when the profile already matches", async () => {
      const linked: Profile = {
        ...DEV_ONLY,
        instances: { development: "ins_dev", production: "ins_prod" },
      };
      await setProfile("key", linked);

      const result = await refreshProfileInstances(
        "key",
        linked,
        application([DEV_INSTANCE, PROD_INSTANCE]),
      );

      expect(result.updated).toEqual([]);
    });

    test("drops a production instance that no longer exists upstream", async () => {
      const linked: Profile = {
        ...DEV_ONLY,
        instances: { development: "ins_dev", production: "ins_gone" },
      };
      await setProfile("key", linked);

      const result = await refreshProfileInstances("key", linked, application([DEV_INSTANCE]));

      expect(result.updated).toEqual(["production"]);
      expect(result.profile.instances.production).toBeUndefined();
      expect((await getProfile("key"))?.instances.production).toBeUndefined();
    });

    test("keeps the recorded development id when the response omits one", async () => {
      const result = await refreshProfileInstances("key", DEV_ONLY, application([PROD_INSTANCE]));

      expect(result.profile.instances.development).toBe("ins_dev");
      expect(result.updated).toEqual(["production"]);
    });
  });

  describe("recoverMissingInstance", () => {
    test("refreshes and resolves after the user confirms", async () => {
      await setProfile("key", DEV_ONLY);
      mockFetchApplication.mockResolvedValue(application([DEV_INSTANCE, PROD_INSTANCE]));
      mockConfirm.mockResolvedValue(true);

      const resolved = await recoverMissingInstance(
        missOn(DEV_ONLY, "prod"),
        "key",
        DEV_ONLY,
        "prod",
      );

      expect(resolved).toEqual({ id: "ins_prod", label: "production" });
      expect((await getProfile("key"))?.instances.production).toBe("ins_prod");
    });

    test("declining leaves the profile untouched and points at --refresh", async () => {
      await setProfile("key", DEV_ONLY);
      mockFetchApplication.mockResolvedValue(application([DEV_INSTANCE, PROD_INSTANCE]));
      mockConfirm.mockResolvedValue(false);

      const promise = recoverMissingInstance(missOn(DEV_ONLY, "prod"), "key", DEV_ONLY, "prod");

      await expect(promise).rejects.toThrow("clerk link --refresh");
      expect((await getProfile("key"))?.instances.production).toBeUndefined();
    });

    test("agent mode fails with the refresh remedy instead of prompting", async () => {
      setMode("agent");
      mockFetchApplication.mockResolvedValue(application([DEV_INSTANCE, PROD_INSTANCE]));

      const promise = recoverMissingInstance(missOn(DEV_ONLY, "prod"), "key", DEV_ONLY, "prod");

      await expect(promise).rejects.toThrow("clerk link --refresh");
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    test("points at `clerk deploy` when the application has no production instance", async () => {
      mockFetchApplication.mockResolvedValue(application([DEV_INSTANCE]));

      const promise = recoverMissingInstance(missOn(DEV_ONLY, "prod"), "key", DEV_ONLY, "prod");

      await expect(promise).rejects.toThrow("clerk deploy");
      expect(mockConfirm).not.toHaveBeenCalled();
    });

    test("rethrows unrelated errors without calling the API", async () => {
      const unrelated = new CliError("boom", { code: ERROR_CODE.AUTH_REQUIRED });

      await expect(recoverMissingInstance(unrelated, "key", DEV_ONLY, "prod")).rejects.toThrow(
        "boom",
      );
      expect(mockFetchApplication).not.toHaveBeenCalled();
    });

    test("rethrows for a literal instance id, which never reaches the alias path", async () => {
      const miss = new CliError("nope", { code: ERROR_CODE.INSTANCE_NOT_FOUND });

      await expect(recoverMissingInstance(miss, "key", DEV_ONLY, "ins_literal")).rejects.toThrow(
        "nope",
      );
      expect(mockFetchApplication).not.toHaveBeenCalled();
    });
  });
});
