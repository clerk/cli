import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { useCaptureLog, promptsStubs } from "../../test/lib/stubs.ts";
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

const mockRunCreateWizard = mock();
mock.module("./create-wizard.ts", () => ({
  runCreateWizard: (...args: unknown[]) => mockRunCreateWizard(...args),
}));

mock.module("@inquirer/prompts", () => promptsStubs);
mock.module("../../lib/spinner.ts", () => ({
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { create } = await import("./create.ts");

describe("users create", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_123");
    mockRunCreateWizard.mockResolvedValue({ fields: {}, targeting: {} });
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: { id: "user_123" },
      rawBody: JSON.stringify({ id: "user_123" }),
    });
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    process.exitCode = 0;
    mockResolveBapiSecretKey.mockReset();
    mockHandleBapiError.mockReset();
    mockHandleBapiError.mockImplementation(() => false);
    mockBapiRequest.mockReset();
    mockIsAgent.mockReset();
    mockRunCreateWizard.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  function runCreate(options: Parameters<typeof create>[0]) {
    return create(options);
  }

  test("curated flags override conflicting JSON payload fields and forward targeting to the secret key resolver", async () => {
    await runCreate({
      app: "app_123",
      data: '{"first_name":"Json","email_address":["json@example.com"]}',
      secretKey: "sk_test_override",
      email: "flag@example.com",
      firstName: "Flag",
      yes: true,
    });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: undefined,
    });
    expect(mockBapiRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "POST",
        path: "/users",
        secretKey: "sk_test_123",
      }),
    );
    expect(JSON.parse(mockBapiRequest.mock.calls[0]?.[0]?.body)).toEqual({
      first_name: "Flag",
      email_address: ["flag@example.com"],
    });
  });

  test("fails with a usage error when no input source is provided", async () => {
    const error = await runCreate({
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

  test("dry-run redacts sensitive preview fields without calling BAPI", async () => {
    await runCreate({
      app: "app_123",
      email: "alice@example.com",
      password: "Password123!",
      dryRun: true,
    });

    expect(captured.err).toContain("[dry-run] POST /v1/users");
    expect(JSON.parse(captured.out)).toEqual({
      email_address: ["alice@example.com"],
      password: "[REDACTED]",
    });
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("prints a terse success message to stderr with no stdout body in human mode", async () => {
    await runCreate({
      app: "app_123",
      email: "alice@example.com",
      yes: true,
    });

    expect(captured.out).toBe("");
    expect(captured.err).toContain("Created user");
    expect(captured.err).toContain("user_123");
    expect(captured.err).not.toContain('"id"');
  });

  test("prints response JSON to stdout when --json output is requested", async () => {
    await runCreate({
      app: "app_123",
      email: "alice@example.com",
      json: true,
      yes: true,
    });

    expect(JSON.parse(captured.out)).toEqual({ id: "user_123" });
    expect(captured.err).not.toContain("Created user");
  });

  test("prints response JSON to stdout in agent mode", async () => {
    mockIsAgent.mockReturnValue(true);

    await runCreate({
      app: "app_123",
      email: "alice@example.com",
      yes: true,
    });

    expect(JSON.parse(captured.out)).toEqual({ id: "user_123" });
    expect(captured.err).not.toContain("Created user");
  });

  test("prints raw BAPI validation errors to stdout for machine use", async () => {
    mockHandleBapiError.mockImplementation((error: unknown) => error instanceof BapiError);
    mockBapiRequest.mockRejectedValue(
      new BapiError(
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
    mockIsAgent.mockReturnValue(true);

    await runCreate({
      app: "app_123",
      email: "alice@example.com",
      yes: true,
    });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(captured.out)).toEqual({
      errors: [
        {
          code: "form_param_missing",
          message: "email_address is required",
        },
      ],
    });
    expect(captured.err).not.toContain("Created user");
  });

  test("invokes the wizard when no flags + human + no data", async () => {
    mockIsAgent.mockReturnValue(false);
    mockRunCreateWizard.mockResolvedValue({
      fields: { email: "alice@example.com" },
      targeting: {},
    });
    await runCreate({ yes: true });
    expect(mockRunCreateWizard).toHaveBeenCalledWith({
      app: undefined,
      instance: undefined,
      secretKey: undefined,
    });
    expect(mockBapiRequest).toHaveBeenCalled();
  });

  test("forwards wizard-resolved targeting to the secret key resolver", async () => {
    mockIsAgent.mockReturnValue(false);
    mockRunCreateWizard.mockResolvedValue({
      fields: { email: "alice@example.com", password: "Password123" },
      targeting: {
        app: "app_picked",
        instance: "ins_dev",
        secretKey: "sk_test_picked",
      },
    });

    await runCreate({ yes: true });

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_picked",
      app: "app_picked",
      instance: "ins_dev",
    });
    expect(mockBapiRequest).toHaveBeenCalled();
  });

  test("agent mode without input throws a structured usage error and never prompts", async () => {
    mockIsAgent.mockReturnValue(true);

    const error = await runCreate({}).catch((caught) => caught);

    expect(error).toBeInstanceOf(CliError);
    expect(error.code).toBe(ERROR_CODE.USAGE_ERROR);
    expect(error.exitCode).toBe(EXIT_CODE.USAGE);
    expect(error.message).toContain("No input provided");
    expect(error.message).toContain("--email alice@example.com");
    expect(error.message).toContain("-d '{");
    expect(error.message).toContain("--file user.json");
    expect(mockRunCreateWizard).not.toHaveBeenCalled();
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });
});
