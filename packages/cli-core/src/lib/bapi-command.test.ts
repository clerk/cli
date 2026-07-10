import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { BapiError, CliError, ERROR_CODE } from "./errors.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

const configModule = await import("./config.ts");
const plapiModule = await import("./plapi.ts");

const {
  normalizeBapiPath,
  handleBapiError,
  resolveBapiSecretKey,
  resolveBapiTarget,
  describeBapiTarget,
  getLastBapiKeySource,
  resetLastBapiKeySource,
} = await import("./bapi-command.ts");

describe("bapi-command", () => {
  let resolveAppContextSpy: ReturnType<typeof spyOn>;
  let resolveProfileSpy: ReturnType<typeof spyOn>;
  let getActiveInstanceForAppSpy: ReturnType<typeof spyOn>;
  let fetchApplicationSpy: ReturnType<typeof spyOn>;
  let validateKeyPrefixSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    resetLastBapiKeySource();
    resolveAppContextSpy = spyOn(configModule, "resolveAppContext");
    resolveProfileSpy = spyOn(configModule, "resolveProfile").mockResolvedValue(undefined);
    getActiveInstanceForAppSpy = spyOn(configModule, "getActiveInstanceForApp").mockResolvedValue(
      undefined,
    );
    fetchApplicationSpy = spyOn(plapiModule, "fetchApplication");
    validateKeyPrefixSpy = spyOn(plapiModule, "validateKeyPrefix");
  });

  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    process.exitCode = 0;
    resolveAppContextSpy.mockRestore();
    resolveProfileSpy.mockRestore();
    getActiveInstanceForAppSpy.mockRestore();
    fetchApplicationSpy.mockRestore();
    validateKeyPrefixSpy.mockRestore();
  });

  test("normalizes unversioned paths", () => {
    expect(normalizeBapiPath("users")).toBe("/v1/users");
    expect(normalizeBapiPath("/users")).toBe("/v1/users");
    expect(normalizeBapiPath("/v1/users")).toBe("/v1/users");
    expect(normalizeBapiPath("v1")).toBe("/v1");
    expect(normalizeBapiPath("/v1")).toBe("/v1");
  });

  test("prints raw BAPI error bodies for machine use", () => {
    const handled = handleBapiError(
      BapiError.fromBody(
        422,
        JSON.stringify({
          errors: [
            {
              code: "form_param_missing",
              message: "email_address is required",
            },
          ],
        }),
        new Headers(),
      ),
    );

    expect(handled).toBe(true);
    expect(JSON.parse(captured.out)).toEqual({
      errors: [
        {
          code: "form_param_missing",
          message: "email_address is required",
        },
      ],
    });
    expect(process.exitCode).toBe(1);
  });

  test("resolves secret key from explicit app and instance", async () => {
    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      name: "My App",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          secret_key: "sk_test_123",
          publishable_key: "pk_test_123",
        },
      ],
    });

    await expect(resolveBapiSecretKey({ app: "app_123", instance: "dev" })).resolves.toBe(
      "sk_test_123",
    );

    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).toHaveBeenCalledTimes(1);
    expect(fetchApplicationSpy).toHaveBeenCalledWith("app_123");
  });

  test("resolves secret key from explicit app and literal instance id", async () => {
    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      name: "My App",
      instances: [
        {
          instance_id: "ins_custom_123",
          environment_type: "staging",
          secret_key: "sk_test_custom_123",
          publishable_key: "pk_test_custom_123",
        },
      ],
    });

    await expect(
      resolveBapiSecretKey({ app: "app_123", instance: "ins_custom_123" }),
    ).resolves.toBe("sk_test_custom_123");

    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).toHaveBeenCalledTimes(1);
  });

  test("throws instance-not-found for explicit app and missing literal instance id", async () => {
    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      name: "My App",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          secret_key: "sk_test_123",
          publishable_key: "pk_test_123",
        },
      ],
    });

    const error = await resolveBapiSecretKey({
      app: "app_123",
      instance: "ins_missing_123",
    }).catch((error_) => error_);

    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(ERROR_CODE.INSTANCE_NOT_FOUND);
    expect(error.message).toContain("Instance ins_missing_123 not found in application.");
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).toHaveBeenCalledTimes(1);
  });

  test("resolves secret key from linked app context when no explicit app is provided", async () => {
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_dev",
      instanceLabel: "development",
      instanceSource: "flag",
    });

    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [{ instance_id: "ins_dev", secret_key: "sk_test_123" }],
    });

    await expect(resolveBapiSecretKey({ instance: "dev" })).resolves.toBe("sk_test_123");
  });

  describe("key source recording", () => {
    test("records an explicit secret key as explicit", async () => {
      validateKeyPrefixSpy.mockImplementation(() => {});
      await resolveBapiTarget({ secretKey: "sk_test_explicit" });
      expect(getLastBapiKeySource()).toEqual({ source: "explicit", instanceLabel: undefined });
    });

    test("records the ambient env key as env", async () => {
      validateKeyPrefixSpy.mockImplementation(() => {});
      process.env.CLERK_SECRET_KEY = "sk_test_env";
      await resolveBapiTarget({});
      expect(getLastBapiKeySource()).toEqual({ source: "env", instanceLabel: undefined });
    });

    describe("env-file attribution", () => {
      let tempDir: string;

      beforeEach(async () => {
        tempDir = await mkdtemp(join(tmpdir(), "clerk-bapi-attribution-"));
        validateKeyPrefixSpy.mockImplementation(() => {});
        process.env.CLERK_SECRET_KEY = "sk_test_ambient";
        resolveProfileSpy.mockResolvedValue({
          path: tempDir,
          profile: { appId: "app_123", instances: { development: "ins_dev" } },
          resolvedVia: "directory",
        });
        getActiveInstanceForAppSpy.mockResolvedValue({
          appId: "app_123",
          instanceId: "ins_branch",
          label: "feature/checkout",
          environmentType: "development",
        });
      });

      afterEach(async () => {
        await rm(tempDir, { recursive: true, force: true });
      });

      test("attributes a matching env-file key to the active pointer", async () => {
        await Bun.write(join(tempDir, ".env.local"), "CLERK_SECRET_KEY=sk_test_ambient\n");

        const target = await resolveBapiTarget({ cwd: tempDir });

        expect(target).toEqual({
          secretKey: "sk_test_ambient",
          instanceLabel: "feature/checkout",
          source: "env-file",
        });
        expect(getLastBapiKeySource()).toEqual({
          source: "env-file",
          instanceLabel: "feature/checkout",
        });
      });

      test("stays plain env when the file key does not match (e.g. switch --no-pull)", async () => {
        await Bun.write(join(tempDir, ".env.local"), "CLERK_SECRET_KEY=sk_test_other\n");

        const target = await resolveBapiTarget({ cwd: tempDir });

        expect(target).toEqual({ secretKey: "sk_test_ambient", source: "env" });
      });

      test("stays plain env without an active pointer", async () => {
        getActiveInstanceForAppSpy.mockResolvedValue(undefined);
        await Bun.write(join(tempDir, ".env.local"), "CLERK_SECRET_KEY=sk_test_ambient\n");

        const target = await resolveBapiTarget({ cwd: tempDir });

        expect(target).toEqual({ secretKey: "sk_test_ambient", source: "env" });
      });

      test("stays plain env when no env file defines the key", async () => {
        const target = await resolveBapiTarget({ cwd: tempDir });

        expect(target).toEqual({ secretKey: "sk_test_ambient", source: "env" });
      });

      test("the highest-precedence env file defining the key decides", async () => {
        // .env.development.local outranks .env.local (mirrors env pull and
        // dotenv tooling); its mismatch wins even though .env.local matches.
        await Bun.write(
          join(tempDir, ".env.development.local"),
          "CLERK_SECRET_KEY=sk_test_other\n",
        );
        await Bun.write(join(tempDir, ".env.local"), "CLERK_SECRET_KEY=sk_test_ambient\n");

        const target = await resolveBapiTarget({ cwd: tempDir });

        expect(target).toEqual({ secretKey: "sk_test_ambient", source: "env" });
      });
    });

    test("records --app resolution as app-flag with the instance label", async () => {
      fetchApplicationSpy.mockResolvedValue({
        application_id: "app_123",
        instances: [
          {
            instance_id: "ins_dev",
            environment_type: "development",
            publishable_key: "pk",
            secret_key: "sk_test_123",
          },
        ],
      });
      const target = await resolveBapiTarget({ app: "app_123", instance: "dev" });
      expect(target).toEqual({
        secretKey: "sk_test_123",
        instanceLabel: "development",
        source: "app-flag",
      });
      expect(getLastBapiKeySource()).toEqual({ source: "app-flag", instanceLabel: "development" });
    });

    test("records the persisted pointer as active-pointer with its label", async () => {
      resolveAppContextSpy.mockResolvedValue({
        appId: "app_123",
        appLabel: "My App",
        instanceId: "ins_branch",
        instanceLabel: "tmp/stale",
        instanceSource: "active-pointer",
      });
      fetchApplicationSpy.mockResolvedValue({
        application_id: "app_123",
        instances: [{ instance_id: "ins_branch", secret_key: "sk_test_b" }],
      });
      await resolveBapiTarget({});
      expect(getLastBapiKeySource()).toEqual({
        source: "active-pointer",
        instanceLabel: "tmp/stale",
      });
    });

    test("names clerk switch when the active pointer's instance is missing", async () => {
      resolveAppContextSpy.mockResolvedValue({
        appId: "app_123",
        appLabel: "My App",
        instanceId: "ins_gone",
        instanceLabel: "tmp/stale",
        instanceSource: "active-pointer",
      });
      fetchApplicationSpy.mockResolvedValue({
        application_id: "app_123",
        instances: [{ instance_id: "ins_dev", secret_key: "sk_test_123" }],
      });

      await expect(resolveBapiTarget({})).rejects.toMatchObject({
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
        message: expect.stringContaining(
          "The active instance `tmp/stale` for this worktree may have been deleted. " +
            "Run `clerk switch` to re-point, then retry.",
        ),
      });
    });

    test("does not add the pointer hint for a missing flag-selected instance", async () => {
      resolveAppContextSpy.mockResolvedValue({
        appId: "app_123",
        appLabel: "My App",
        instanceId: "ins_gone",
        instanceLabel: "ins_gone",
        instanceSource: "flag",
      });
      fetchApplicationSpy.mockResolvedValue({
        application_id: "app_123",
        instances: [{ instance_id: "ins_dev", secret_key: "sk_test_123" }],
      });

      await expect(resolveBapiTarget({ instance: "ins_gone" })).rejects.toMatchObject({
        code: ERROR_CODE.INSTANCE_NOT_FOUND,
        message: expect.not.stringContaining("clerk switch"),
      });
    });

    test("records the development fallback as default", async () => {
      resolveAppContextSpy.mockResolvedValue({
        appId: "app_123",
        appLabel: "My App",
        instanceId: "ins_dev",
        instanceLabel: "development",
        instanceSource: "default",
      });
      fetchApplicationSpy.mockResolvedValue({
        application_id: "app_123",
        instances: [{ instance_id: "ins_dev", secret_key: "sk_test_123" }],
      });
      await resolveBapiTarget({});
      expect(getLastBapiKeySource()).toEqual({ source: "default", instanceLabel: "development" });
    });
  });

  test("resolves secret key from explicit app and branch", async () => {
    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_1",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk",
          secret_key: "sk_dev",
        },
        {
          instance_id: "ins_b",
          environment_type: "development",
          publishable_key: "pk",
          secret_key: "sk_branch",
          branch_name: "pr-9",
          parent_instance_id: "ins_dev",
        },
      ],
    });

    await expect(resolveBapiSecretKey({ app: "app_1", branch: "pr-9" })).resolves.toBe("sk_branch");

    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).toHaveBeenCalledWith("app_1");
  });

  test("resolves secret key from linked app context with a branch", async () => {
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_b",
      instanceLabel: "pr-9",
    });

    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [{ instance_id: "ins_b", secret_key: "sk_branch_123" }],
    });

    await expect(resolveBapiSecretKey({ branch: "pr-9" })).resolves.toBe("sk_branch_123");

    expect(resolveAppContextSpy).toHaveBeenCalledWith({
      app: undefined,
      instance: undefined,
      branch: "pr-9",
    });
  });

  test("rejects --branch combined with --instance before any resolution", async () => {
    const error = await resolveBapiSecretKey({ branch: "pr-9", instance: "prod" }).catch(
      (error_) => error_,
    );

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      "Cannot combine --branch and --instance. Pass only one to select an instance.",
    );
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
  });

  test("rejects --branch combined with --secret-key instead of silently ignoring --branch", async () => {
    const error = await resolveBapiSecretKey({
      branch: "pr-9",
      secretKey: "sk_test_direct",
    }).catch((error_) => error_);

    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe(
      "Cannot combine --branch and --secret-key. A secret key already targets a specific instance.",
    );
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
  });

  test("prefers an explicit secret key over env and app resolution", async () => {
    process.env.CLERK_SECRET_KEY = "sk_env_123";

    await expect(
      resolveBapiSecretKey({
        secretKey: "sk_option_123",
        app: "app_123",
        instance: "dev",
      }),
    ).resolves.toBe("sk_option_123");

    expect(validateKeyPrefixSpy).toHaveBeenCalledWith("sk_option_123", "sk_");
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
  });

  test("prefers explicit app targeting over CLERK_SECRET_KEY", async () => {
    process.env.CLERK_SECRET_KEY = "sk_env_123";
    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          secret_key: "sk_test_123",
        },
      ],
    });

    await expect(resolveBapiSecretKey({ app: "app_123", instance: "dev" })).resolves.toBe(
      "sk_test_123",
    );

    expect(validateKeyPrefixSpy).not.toHaveBeenCalledWith("sk_env_123", "sk_");
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).toHaveBeenCalledWith("app_123");
  });

  test("falls back to CLERK_SECRET_KEY when no explicit app, instance, or branch is provided", async () => {
    process.env.CLERK_SECRET_KEY = "sk_env_123";

    await expect(resolveBapiSecretKey({})).resolves.toBe("sk_env_123");

    expect(validateKeyPrefixSpy).toHaveBeenCalledWith("sk_env_123", "sk_");
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
  });

  test("prefers an explicit --branch over ambient CLERK_SECRET_KEY", async () => {
    process.env.CLERK_SECRET_KEY = "sk_env_123";
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_b",
      instanceLabel: "pr-9",
    });

    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [{ instance_id: "ins_b", secret_key: "sk_branch_123" }],
    });

    await expect(resolveBapiSecretKey({ branch: "pr-9" })).resolves.toBe("sk_branch_123");

    expect(resolveAppContextSpy).toHaveBeenCalledWith({
      app: undefined,
      instance: undefined,
      branch: "pr-9",
    });
  });

  test("prefers an explicit --instance over ambient CLERK_SECRET_KEY", async () => {
    process.env.CLERK_SECRET_KEY = "sk_env_123";
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_prod",
      instanceLabel: "production",
    });

    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [{ instance_id: "ins_prod", secret_key: "sk_prod_123" }],
    });

    await expect(resolveBapiSecretKey({ instance: "prod" })).resolves.toBe("sk_prod_123");

    expect(resolveAppContextSpy).toHaveBeenCalledWith({
      app: undefined,
      instance: "prod",
      branch: undefined,
    });
  });

  test("remaps not-linked app context errors to a no-secret-key usage error", async () => {
    resolveAppContextSpy.mockRejectedValue(
      new CliError("linked profile missing", {
        code: ERROR_CODE.NOT_LINKED,
      }),
    );

    const error = await resolveBapiSecretKey({}).catch((error_) => error_);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(ERROR_CODE.NO_SECRET_KEY);
    expect(error.exitCode).toBe(2);
    expect(error.docsUrl).toContain(
      "https://clerk.com/docs/guides/development/clerk-environment-variables",
    );
    expect(error.message).toContain("No secret key found.");

    expect(fetchApplicationSpy).not.toHaveBeenCalled();
  });

  test("describes the resolved app and instance target", async () => {
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_prod",
      instanceLabel: "production",
    });

    await expect(describeBapiTarget({ app: "app_123", instance: "prod" })).resolves.toBe(
      "My App (production)",
    );

    expect(resolveAppContextSpy).toHaveBeenCalledWith({
      app: "app_123",
      instance: "prod",
    });
  });

  test("describes the resolved app and instance target with a branch", async () => {
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_b",
      instanceLabel: "pr-9",
    });

    await expect(describeBapiTarget({ app: "app_123", branch: "pr-9" })).resolves.toBe(
      "My App (pr-9)",
    );

    expect(resolveAppContextSpy).toHaveBeenCalledWith({
      app: "app_123",
      instance: undefined,
      branch: "pr-9",
    });
  });

  test("returns no target description when only a secret key is available", async () => {
    resolveAppContextSpy.mockRejectedValue(
      new CliError("linked profile missing", {
        code: ERROR_CODE.NOT_LINKED,
      }),
    );

    await expect(describeBapiTarget({ secretKey: "sk_test_123" })).resolves.toBeUndefined();
  });

  test("throws instance-not-found when the resolved instance is missing from the application", async () => {
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_missing",
      instanceLabel: "development",
    });

    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          secret_key: "sk_test_123",
          publishable_key: "pk_test_123",
        },
      ],
    });

    const error = await resolveBapiSecretKey({}).catch((error_) => error_);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(ERROR_CODE.INSTANCE_NOT_FOUND);
    expect(error.message).toContain("Instance ins_missing not found in application.");
  });

  test("throws no-secret-key when the resolved instance has no secret key", async () => {
    resolveAppContextSpy.mockResolvedValue({
      appId: "app_123",
      appLabel: "My App",
      instanceId: "ins_dev",
      instanceLabel: "development",
    });

    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [
        {
          instance_id: "ins_dev",
          environment_type: "development",
          publishable_key: "pk_test_123",
        },
      ],
    });

    const error = await resolveBapiSecretKey({}).catch((error_) => error_);
    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(ERROR_CODE.NO_SECRET_KEY);
    expect(error.message).toContain("No secret key found for development instance.");
  });
});
