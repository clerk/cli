import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureLog, promptsStubs } from "../../test/lib/stubs.ts";
import { BapiError, CliError, ERROR_CODE, EXIT_CODE } from "../../lib/errors.ts";

const mockResolveBapiSecretKey = mock();
const mockHandleBapiError = mock((_error: unknown) => false);
mock.module("../../lib/bapi-command.ts", () => ({
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
  handleBapiError: (error: unknown) => mockHandleBapiError(error),
}));

const mockBapiRequest = mock();
mock.module("../../commands/api/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => "human",
}));

mock.module("@inquirer/prompts", () => promptsStubs);
mock.module("../../lib/spinner.ts", () => ({
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { update } = await import("./update.ts");

describe("users update", () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-users-update-test-"));
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { id: "user_123" },
      rawBody: JSON.stringify({ id: "user_123" }),
    });
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();
  });

  afterEach(async () => {
    captured.teardown();
    process.exitCode = 0;
    mockResolveBapiSecretKey.mockReset();
    mockHandleBapiError.mockReset();
    mockHandleBapiError.mockImplementation(() => false);
    mockBapiRequest.mockReset();
    mockIsAgent.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  function runUpdate(userId: string, options: Parameters<typeof update>[1]) {
    return captured.run(() => update(userId, options));
  }

  test("fails with a usage error when no input source is provided", async () => {
    const error = await runUpdate("user_123", {
      app: "app_123",
      yes: true,
    }).catch((error_) => error_);

    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(ERROR_CODE.USAGE_ERROR);
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("No input provided");
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("sends only the changed fields from curated flags", async () => {
    await runUpdate("user_123", {
      app: "app_123",
      lastName: "Updated",
      yes: true,
    });

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/users/user_123",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        last_name: "Updated",
      }),
    });
  });

  test("curated flags override conflicting file payload fields and forward targeting to the secret key resolver", async () => {
    const payloadFile = join(tempDir, "payload.json");
    await Bun.write(
      payloadFile,
      JSON.stringify({
        first_name: "Json",
        username: "json-user",
      }),
    );

    await runUpdate("user_123", {
      app: "app_123",
      file: payloadFile,
      secretKey: "sk_test_override",
      firstName: "Flag",
      username: "flag-user",
      yes: true,
    });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: undefined,
    });
    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/users/user_123",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        first_name: "Flag",
        username: "flag-user",
      }),
    });
  });

  test("merges inline -d payload with curated flags overriding conflicts", async () => {
    await runUpdate("user_123", {
      app: "app_123",
      data: '{"first_name":"Data","last_name":"Payload","username":"data-user"}',
      firstName: "Flag",
      username: "flag-user",
      yes: true,
    });

    expect(mockBapiRequest).toHaveBeenCalledWith({
      method: "PATCH",
      path: "/users/user_123",
      secretKey: "sk_test_123",
      body: JSON.stringify({
        first_name: "Flag",
        last_name: "Payload",
        username: "flag-user",
      }),
    });
  });

  test("dry-run redacts sensitive preview fields without calling BAPI", async () => {
    await runUpdate("user_123", {
      app: "app_123",
      password: "Password123!",
      dryRun: true,
    });

    expect(captured.err).toContain("[dry-run] PATCH /v1/users/user_123");
    expect(JSON.parse(captured.out)).toEqual({
      password: "[REDACTED]",
    });
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("prints a terse success message to stderr with no stdout body in human mode", async () => {
    await runUpdate("user_123", {
      app: "app_123",
      firstName: "Alice",
      yes: true,
    });

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Updated user");
    expect(captured.err).toContain("user_123");
    expect(captured.err).not.toContain('"id"');
  });

  test("prints response JSON to stdout when --json output is requested", async () => {
    await runUpdate("user_123", {
      app: "app_123",
      firstName: "Alice",
      json: true,
      yes: true,
    });

    expect(JSON.parse(captured.out)).toEqual({ id: "user_123" });
    expect(captured.err).not.toContain("Updated user");
  });

  test("prints response JSON to stdout in agent mode", async () => {
    mockIsAgent.mockReturnValue(true);

    await runUpdate("user_123", {
      app: "app_123",
      firstName: "Alice",
      yes: true,
    });

    expect(JSON.parse(captured.out)).toEqual({ id: "user_123" });
    expect(captured.err).not.toContain("Updated user");
  });

  test("prints concise BAPI validation errors to stderr in human mode", async () => {
    mockHandleBapiError.mockImplementation((error: unknown) => error instanceof BapiError);
    mockBapiRequest.mockRejectedValue(
      new BapiError(
        422,
        JSON.stringify({
          errors: [
            {
              code: "form_param_invalid",
              message: "username has already been taken",
            },
          ],
        }),
        new Headers(),
      ),
    );

    await runUpdate("user_123", {
      app: "app_123",
      username: "alice",
      yes: true,
    });

    expect(process.exitCode).toBe(1);
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Failed to update user user_123");
    expect(captured.err).toContain("username has already been taken");
  });
});
