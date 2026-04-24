import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProgram } from "../../cli-program.ts";
import { captureLog } from "../../test/lib/stubs.ts";
import { BapiError, CliError, ERROR_CODE, EXIT_CODE } from "../../lib/errors.ts";

const mockBapiRequest = mock();
mock.module("../../commands/api/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockResolveBapiSecretKey = mock();
const mockDescribeBapiTarget = mock();
const mockHandleBapiError = mock((_error: unknown) => false);
mock.module("../../lib/bapi-command.ts", () => ({
  normalizeBapiPath: (path: string) => {
    let normalized = path;
    if (!normalized.startsWith("/")) normalized = `/${normalized}`;
    if (!normalized.startsWith("/v1/")) normalized = `/v1${normalized}`;
    return normalized;
  },
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
  describeBapiTarget: (...args: unknown[]) => mockDescribeBapiTarget(...args),
  handleBapiError: (error: unknown) => mockHandleBapiError(error),
}));

const mockLoggedFetch = mock();
mock.module("../../lib/fetch.ts", () => ({
  loggedFetch: (...args: unknown[]) => mockLoggedFetch(...args),
}));

mock.module("../../lib/environment.ts", () => ({
  getBapiBaseUrl: () => "https://api.clerk.test",
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

const mockConfirm = mock();
mock.module("../../lib/prompts.ts", () => ({
  confirm: (...args: unknown[]) => mockConfirm(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { metadata } = await import("./metadata.ts");
const { profileImage } = await import("./profile-image.ts");
const { password } = await import("./password.ts");
const { mfa } = await import("./mfa.ts");

describe("users specialized commands", () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-users-specialized-test-"));
    mockIsAgent.mockReturnValue(true);
    mockConfirm.mockResolvedValue(true);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockDescribeBapiTarget.mockResolvedValue("My App (production)");
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { ok: true },
      rawBody: JSON.stringify({ ok: true }),
    });
    mockLoggedFetch.mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();
  });

  afterEach(async () => {
    captured.teardown();
    process.exitCode = 0;
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockDescribeBapiTarget.mockReset();
    mockHandleBapiError.mockReset();
    mockHandleBapiError.mockImplementation(() => false);
    mockLoggedFetch.mockReset();
    mockIsAgent.mockReset();
    mockConfirm.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("metadata patches the metadata endpoint from inline JSON input", async () => {
    await captured.run(() =>
      metadata("user_123", {
        data: JSON.stringify({
          public_metadata: { role: "admin" },
          private_metadata: { source: "cli" },
        }),
        secretKey: "sk_test_override",
        app: "app_123",
        instance: "prod",
        yes: true,
      }),
    );

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/users/user_123/metadata",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        public_metadata: { role: "admin" },
        private_metadata: { source: "cli" },
      }),
    });
    expect(JSON.parse(captured.out)).toEqual({ ok: true });
  });

  test("metadata prints terse success to stderr by default in human mode", async () => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(() =>
      metadata("user_123", {
        data: JSON.stringify({
          public_metadata: { role: "admin" },
        }),
        yes: true,
      }),
    );

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Updated metadata for user user_123");
    expect(captured.err).not.toContain('"ok"');
  });

  test("metadata prints response JSON to stdout when --json is requested", async () => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(() =>
      metadata("user_123", {
        data: JSON.stringify({
          public_metadata: { role: "admin" },
        }),
        json: true,
        yes: true,
      }),
    );

    expect(JSON.parse(captured.out)).toEqual({ ok: true });
    expect(captured.err).not.toContain("Updated metadata for user user_123");
  });

  test("metadata accepts file payload input", async () => {
    const payloadPath = join(tempDir, "metadata.json");
    await Bun.write(
      payloadPath,
      JSON.stringify({
        unsafe_metadata: { plan: "pro" },
      }),
    );

    await captured.run(() =>
      metadata("user_123", {
        file: payloadPath,
        secretKey: "sk_test_override",
        yes: true,
      }),
    );

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/users/user_123/metadata",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        unsafe_metadata: { plan: "pro" },
      }),
    });
  });

  test("metadata dry-run redacts private and unsafe metadata and prints the resolved target", async () => {
    await captured.run(() =>
      metadata("user_123", {
        data: JSON.stringify({
          public_metadata: { role: "admin" },
          private_metadata: { source: "cli" },
          unsafe_metadata: { plan: "pro" },
        }),
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );

    expect(captured.err).toContain(
      "[dry-run] PATCH /v1/users/user_123/metadata for My App (production)",
    );
    expect(JSON.parse(captured.out)).toEqual({
      public_metadata: { role: "admin" },
      private_metadata: "[REDACTED]",
      unsafe_metadata: "[REDACTED]",
    });
    expect(mockDescribeBapiTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("profile-image uploads a local file to the profile_image endpoint", async () => {
    const imagePath = join(tempDir, "avatar.png");
    await Bun.write(imagePath, "fake-image-bytes");

    await captured.run(() =>
      profileImage("user_123", {
        set: imagePath,
        secretKey: "sk_test_override",
        app: "app_123",
        instance: "prod",
        yes: true,
      }),
    );

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
    expect(mockLoggedFetch).toHaveBeenCalledTimes(1);
    const [url, init] = mockLoggedFetch.mock.calls[0]!;
    expect(url).toBe("https://api.clerk.test/v1/users/user_123/profile_image");
    expect(init).toMatchObject({
      tag: "bapi",
      method: "POST",
      headers: {
        Authorization: "Bearer sk_test_123",
        Accept: "application/json",
      },
    });
    expect(init.body).toBeInstanceOf(FormData);
    expect(JSON.parse(captured.out)).toEqual({ ok: true });
  });

  test("profile-image remove maps to the delete endpoint", async () => {
    await captured.run(() =>
      profileImage("user_123", {
        remove: true,
        secretKey: "sk_test_override",
        yes: true,
      }),
    );

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/users/user_123/profile_image",
      secretKey: "sk_test_123",
    });
  });

  test("profile-image set prints terse success in human mode", async () => {
    mockIsAgent.mockReturnValue(false);
    const imagePath = join(tempDir, "avatar-human.png");
    await Bun.write(imagePath, "fake-image-bytes");

    await captured.run(() =>
      profileImage("user_123", {
        set: imagePath,
        yes: true,
      }),
    );

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Set profile image for user user_123");
  });

  test("profile-image remove prints terse success in human mode", async () => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(() =>
      profileImage("user_123", {
        remove: true,
        yes: true,
      }),
    );

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Removed profile image for user user_123");
  });

  test("password verify requires an explicit action flag", async () => {
    const error = await captured
      .run(() =>
        password("user_123", {
          password: "Password123!",
        }),
      )
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.USAGE_ERROR);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as CliError).message).toContain("Choose exactly one password action");
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("password fails with a usage error when invoked with no sub-action", async () => {
    const error = await captured
      .run(() =>
        password("user_123", {
          secretKey: "sk_test_override",
        }),
      )
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.USAGE_ERROR);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as CliError).message).toContain("Choose exactly one password action");
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("password verify maps to the verify_password endpoint", async () => {
    await captured.run(() =>
      password("user_123", {
        verify: true,
        password: "Password123!",
        secretKey: "sk_test_override",
        app: "app_123",
        instance: "prod",
      }),
    );

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/users/user_123/verify_password",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        password: "Password123!",
      }),
    });
  });

  test("password verify prompts in human mode and prints terse success", async () => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(() =>
      password("user_123", {
        verify: true,
        password: "Password123!",
      }),
    );

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(captured.err).toContain("About to POST /users/user_123/verify_password");
    expect(captured.err).toContain('"password": "[REDACTED]"');
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Verified password for user user_123");
  });

  test("password verify skips confirmation when --yes is passed", async () => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(() =>
      password("user_123", {
        verify: true,
        password: "Password123!",
        yes: true,
      }),
    );

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("password verify prints raw BAPI errors to stdout for machine use", async () => {
    mockHandleBapiError.mockImplementation((error: unknown) => error instanceof BapiError);
    mockBapiRequest.mockRejectedValue(
      new BapiError(
        422,
        JSON.stringify({
          errors: [
            {
              code: "form_param_invalid",
              message: "password is invalid",
            },
          ],
        }),
        new Headers(),
      ),
    );

    await captured.run(() =>
      password("user_123", {
        verify: true,
        password: "Password123!",
        json: true,
        yes: true,
      }),
    );

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(captured.out)).toEqual({
      errors: [
        {
          code: "form_param_invalid",
          message: "password is invalid",
        },
      ],
    });
    expect(captured.err).not.toContain("Verified password for user user_123");
  });

  test("password dry-run prints the specialized verify endpoint and resolved target without calling BAPI", async () => {
    await captured.run(() =>
      password("user_123", {
        verify: true,
        password: "Password123!",
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );

    expect(captured.err).toContain(
      "[dry-run] POST /v1/users/user_123/verify_password for My App (production)",
    );
    expect(JSON.parse(captured.out)).toEqual({
      password: "[REDACTED]",
    });
    expect(mockDescribeBapiTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("mfa requires exactly one explicit action", async () => {
    const error = await captured
      .run(() =>
        mfa("user_123", {
          disable: true,
          removeTotp: true,
        }),
      )
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.USAGE_ERROR);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as CliError).message).toContain("Choose exactly one MFA action");
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("mfa fails with a usage error when invoked with no sub-action", async () => {
    const error = await captured
      .run(() =>
        mfa("user_123", {
          secretKey: "sk_test_override",
        }),
      )
      .catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).code).toBe(ERROR_CODE.USAGE_ERROR);
    expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
    expect((error as CliError).message).toContain("Choose exactly one MFA action");
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("mfa verify maps to the verify_totp endpoint", async () => {
    await captured.run(() =>
      mfa("user_123", {
        verify: true,
        code: "123456",
        secretKey: "sk_test_override",
        app: "app_123",
        instance: "prod",
      }),
    );

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "POST",
      path: "/users/user_123/verify_totp",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        code: "123456",
      }),
    });
  });

  test("mfa verify prompts in human mode and prints terse success", async () => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(() =>
      mfa("user_123", {
        verify: true,
        code: "123456",
      }),
    );

    expect(mockConfirm).toHaveBeenCalledTimes(1);
    expect(captured.err).toContain("About to POST /users/user_123/verify_totp");
    expect(captured.err).toContain('"code": "[REDACTED]"');
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Verified MFA for user user_123");
  });

  test("mfa verify skips confirmation when --yes is passed", async () => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(() =>
      mfa("user_123", {
        verify: true,
        code: "123456",
        yes: true,
      }),
    );

    expect(mockConfirm).not.toHaveBeenCalled();
  });

  test("mfa verify dry-run redacts the MFA code and prints the resolved target", async () => {
    await captured.run(() =>
      mfa("user_123", {
        verify: true,
        code: "123456",
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );

    expect(captured.err).toContain(
      "[dry-run] POST /v1/users/user_123/verify_totp for My App (production)",
    );
    expect(JSON.parse(captured.out)).toEqual({
      code: "[REDACTED]",
    });
    expect(mockDescribeBapiTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("mfa disable maps to the mfa endpoint", async () => {
    await captured.run(() =>
      mfa("user_123", {
        disable: true,
        secretKey: "sk_test_override",
        yes: true,
      }),
    );

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/users/user_123/mfa",
      secretKey: "sk_test_123",
    });
  });

  test.each([
    {
      name: "disable",
      run: () => mfa("user_123", { disable: true, yes: true }),
      message: "Disabled MFA for user user_123",
    },
    {
      name: "remove TOTP",
      run: () => mfa("user_123", { removeTotp: true, yes: true }),
      message: "Removed TOTP for user user_123",
    },
    {
      name: "remove backup codes",
      run: () => mfa("user_123", { removeBackupCodes: true, yes: true }),
      message: "Removed backup codes for user user_123",
    },
  ])("mfa $name prints terse success in human mode", async ({ run, message }) => {
    mockIsAgent.mockReturnValue(false);

    await captured.run(run);

    expect(captured.out).toBe("");
    expect(captured.err).toContain(message);
  });

  test("metadata prints concise BAPI errors to stderr in human mode", async () => {
    mockIsAgent.mockReturnValue(false);
    mockHandleBapiError.mockImplementation((error: unknown) => error instanceof BapiError);
    mockBapiRequest.mockRejectedValue(
      new BapiError(
        422,
        JSON.stringify({
          errors: [
            {
              code: "form_param_invalid",
              message: "public_metadata must be an object",
            },
          ],
        }),
        new Headers(),
      ),
    );

    await captured.run(() =>
      metadata("user_123", {
        data: JSON.stringify({
          public_metadata: "admin",
        }),
        yes: true,
      }),
    );

    expect(process.exitCode).toBe(1);
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Failed to update metadata for user user_123");
    expect(captured.err).toContain("public_metadata must be an object");
  });

  test("mfa remove-totp maps to the totp endpoint", async () => {
    await captured.run(() =>
      mfa("user_123", {
        removeTotp: true,
        secretKey: "sk_test_override",
        yes: true,
      }),
    );

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/users/user_123/totp",
      secretKey: "sk_test_123",
    });
  });

  test("mfa backup code removal maps to the backup_code endpoint", async () => {
    await captured.run(() =>
      mfa("user_123", {
        removeBackupCodes: true,
        secretKey: "sk_test_override",
        yes: true,
      }),
    );

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "DELETE",
      path: "/users/user_123/backup_code",
      secretKey: "sk_test_123",
    });
  });

  test("cli registers explicit specialized user options", () => {
    const program = createProgram();
    const users = program.commands.find((command) => command.name() === "users")!;
    const optionNames = (name: string) =>
      users.commands
        .find((command) => command.name() === name)!
        .options.map((option) => option.long);

    expect(optionNames("metadata")).toEqual(
      expect.arrayContaining([
        "--json",
        "--data",
        "--file",
        "--secret-key",
        "--app",
        "--instance",
        "--dry-run",
        "--yes",
      ]),
    );
    expect(optionNames("profile-image")).toEqual(
      expect.arrayContaining([
        "--json",
        "--set",
        "--remove",
        "--secret-key",
        "--app",
        "--instance",
        "--dry-run",
        "--yes",
      ]),
    );
    expect(optionNames("password")).toEqual(
      expect.arrayContaining([
        "--json",
        "--verify",
        "--password",
        "--secret-key",
        "--app",
        "--instance",
        "--dry-run",
        "--yes",
      ]),
    );
    expect(optionNames("mfa")).toEqual(
      expect.arrayContaining([
        "--json",
        "--disable",
        "--remove-totp",
        "--remove-backup-codes",
        "--verify",
        "--code",
        "--secret-key",
        "--app",
        "--instance",
        "--dry-run",
        "--yes",
      ]),
    );
  });

  test("profile-image dry-run prints the upload target without calling BAPI", async () => {
    const imagePath = join(tempDir, "avatar-dry-run.png");
    await Bun.write(imagePath, "fake-image-bytes");

    await captured.run(() =>
      profileImage("user_123", {
        set: imagePath,
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );

    expect(captured.err).toContain(
      `[dry-run] POST /v1/users/user_123/profile_image for My App (production)`,
    );
    expect(JSON.parse(captured.out)).toEqual({
      file: imagePath,
    });
    expect(mockDescribeBapiTarget).toHaveBeenCalledWith(
      expect.objectContaining({
        app: "app_123",
        instance: "prod",
        dryRun: true,
      }),
    );
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockLoggedFetch).not.toHaveBeenCalled();
  });
});
