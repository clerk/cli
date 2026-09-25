import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { BapiError, CliError, ERROR_CODE } from "./errors.ts";
import { useCaptureLog } from "../test/lib/stubs.ts";

const configModule = await import("./config.ts");
const plapiModule = await import("./plapi.ts");
const keylessTargetModule = await import("./keyless-target.ts");

const { normalizeBapiPath, handleBapiError, resolveBapiSecretKey, describeBapiTarget } =
  await import("./bapi-command.ts");

describe("bapi-command", () => {
  let resolveAppContextSpy: ReturnType<typeof spyOn>;
  let fetchApplicationSpy: ReturnType<typeof spyOn>;
  let validateKeyPrefixSpy: ReturnType<typeof spyOn>;
  let resolveKeylessTargetSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    resolveAppContextSpy = spyOn(configModule, "resolveAppContext");
    fetchApplicationSpy = spyOn(plapiModule, "fetchApplication");
    validateKeyPrefixSpy = spyOn(plapiModule, "validateKeyPrefix");
    // Defaults to "no keyless project here" so existing account-path tests are
    // unaffected; individual tests override this to exercise the keyless path.
    resolveKeylessTargetSpy = spyOn(keylessTargetModule, "resolveKeylessTarget").mockResolvedValue(
      undefined,
    );
  });

  afterEach(() => {
    delete process.env.CLERK_SECRET_KEY;
    process.exitCode = 0;
    resolveAppContextSpy.mockRestore();
    fetchApplicationSpy.mockRestore();
    validateKeyPrefixSpy.mockRestore();
    resolveKeylessTargetSpy.mockRestore();
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
    });

    fetchApplicationSpy.mockResolvedValue({
      application_id: "app_123",
      instances: [{ instance_id: "ins_dev", secret_key: "sk_test_123" }],
    });

    await expect(resolveBapiSecretKey({ instance: "dev" })).resolves.toBe("sk_test_123");
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

  test("an exported CLERK_SECRET_KEY wins over a linked profile", async () => {
    process.env.CLERK_SECRET_KEY = "sk_env_123";

    await expect(resolveBapiSecretKey({})).resolves.toBe("sk_env_123");

    // The env var is explicit user intent: neither the keyless resolver (which
    // stands down for linked directories) nor the profile lookup runs at all.
    expect(resolveKeylessTargetSpy).not.toHaveBeenCalled();
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
  });

  test("--instance stays a no-op next to an exported CLERK_SECRET_KEY", async () => {
    process.env.CLERK_SECRET_KEY = "sk_env_123";

    // The key addresses exactly one instance, so --instance has always been
    // ignored here — never a usage error.
    await expect(resolveBapiSecretKey({ instance: "prod" })).resolves.toBe("sk_env_123");

    expect(resolveKeylessTargetSpy).not.toHaveBeenCalled();
  });

  test("rejects an exported CLERK_SECRET_KEY that is not a secret key", async () => {
    process.env.CLERK_SECRET_KEY = "pk_test_not_secret";
    validateKeyPrefixSpy.mockImplementation(() => {
      throw new Error("bad prefix");
    });

    await expect(resolveBapiSecretKey({})).rejects.toThrow("bad prefix");
    expect(validateKeyPrefixSpy).toHaveBeenCalledWith("pk_test_not_secret", "sk_");
  });

  test("falls back to the shared keyless resolution when no explicit app or secret key is provided", async () => {
    resolveKeylessTargetSpy.mockResolvedValue({
      secretKey: "sk_keyless_123",
      source: ".env.local",
    });

    await expect(resolveBapiSecretKey({ instance: "dev" })).resolves.toBe("sk_keyless_123");

    expect(resolveKeylessTargetSpy).toHaveBeenCalledWith({ instance: "dev", cwd: undefined });
    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
  });

  test("prefers an explicit app over the keyless project's own key", async () => {
    resolveKeylessTargetSpy.mockResolvedValue({
      secretKey: "sk_keyless_123",
      source: ".env.local",
    });
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

    expect(resolveKeylessTargetSpy).not.toHaveBeenCalled();
  });

  test("prefers keyless resolution over the account-linked fallback", async () => {
    resolveKeylessTargetSpy.mockResolvedValue({
      secretKey: "sk_keyless_123",
      source: ".env.local",
    });

    await expect(resolveBapiSecretKey({})).resolves.toBe("sk_keyless_123");

    expect(resolveAppContextSpy).not.toHaveBeenCalled();
    expect(fetchApplicationSpy).not.toHaveBeenCalled();
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

  test("returns no target description when only a secret key is available", async () => {
    resolveAppContextSpy.mockRejectedValue(
      new CliError("linked profile missing", {
        code: ERROR_CODE.NOT_LINKED,
      }),
    );

    await expect(describeBapiTarget({ secretKey: "sk_test_123" })).resolves.toBeUndefined();
  });

  test("describes an unclaimed keyless target without querying the account", async () => {
    resolveKeylessTargetSpy.mockResolvedValue({ secretKey: "sk_test_123", source: ".env.local" });

    await expect(describeBapiTarget({})).resolves.toBe(
      "this accountless application (secret key from .env.local)",
    );

    expect(resolveAppContextSpy).not.toHaveBeenCalled();
  });

  test("an explicit --secret-key wins over a keyless target on disk, matching resolveBapiSecretKey", async () => {
    resolveKeylessTargetSpy.mockResolvedValue({ secretKey: "sk_test_disk", source: ".env.local" });

    await expect(describeBapiTarget({ secretKey: "sk_test_explicit" })).resolves.toBeUndefined();

    expect(resolveKeylessTargetSpy).not.toHaveBeenCalled();
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
