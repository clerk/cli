import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import { createProgram } from "../../cli-program.ts";
import { captureLog } from "../../test/lib/stubs.ts";
import { BapiError, UserAbortError } from "../../lib/errors.ts";

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

const { remove } = await import("./delete.ts");
const { ban } = await import("./ban.ts");
const { unban } = await import("./unban.ts");
const { lock } = await import("./lock.ts");
const { unlock } = await import("./unlock.ts");

describe("users lifecycle commands", () => {
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
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
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    process.exitCode = 0;
    mockBapiRequest.mockReset();
    mockResolveBapiSecretKey.mockReset();
    mockDescribeBapiTarget.mockReset();
    mockHandleBapiError.mockReset();
    mockHandleBapiError.mockImplementation(() => false);
    mockIsAgent.mockReset();
    mockConfirm.mockReset();
    logSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test.each([
    {
      name: "delete",
      run: () =>
        captured.run(() =>
          remove("user_123", {
            secretKey: "sk_test_override",
            app: "app_123",
            instance: "prod",
            yes: true,
          }),
        ),
      request: {
        method: "DELETE",
        path: "/users/user_123",
        secretKey: "sk_test_123",
      },
    },
    {
      name: "ban",
      run: () =>
        captured.run(() =>
          ban("user_123", {
            secretKey: "sk_test_override",
            app: "app_123",
            instance: "prod",
            yes: true,
          }),
        ),
      request: {
        method: "POST",
        path: "/users/user_123/ban",
        secretKey: "sk_test_123",
      },
    },
    {
      name: "unban",
      run: () =>
        captured.run(() =>
          unban("user_123", {
            secretKey: "sk_test_override",
            app: "app_123",
            instance: "prod",
            yes: true,
          }),
        ),
      request: {
        method: "POST",
        path: "/users/user_123/unban",
        secretKey: "sk_test_123",
      },
    },
    {
      name: "lock",
      run: () =>
        captured.run(() =>
          lock("user_123", {
            secretKey: "sk_test_override",
            app: "app_123",
            instance: "prod",
            yes: true,
          }),
        ),
      request: {
        method: "POST",
        path: "/users/user_123/lock",
        secretKey: "sk_test_123",
      },
    },
    {
      name: "unlock",
      run: () =>
        captured.run(() =>
          unlock("user_123", {
            secretKey: "sk_test_override",
            app: "app_123",
            instance: "prod",
            yes: true,
          }),
        ),
      request: {
        method: "POST",
        path: "/users/user_123/unlock",
        secretKey: "sk_test_123",
      },
    },
  ])("$name resolves the secret key and sends the expected request", async ({ run, request }) => {
    await run();

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_override",
      app: "app_123",
      instance: "prod",
    });
    expect(mockBapiRequest).toHaveBeenCalledWith(request);
    expect(JSON.parse(captured.out)).toEqual({ ok: true });
  });

  test.each([
    {
      name: "delete",
      run: () => captured.run(() => remove("user_123", { yes: true })),
      message: "Deleted user user_123",
    },
    {
      name: "ban",
      run: () => captured.run(() => ban("user_123", { yes: true })),
      message: "Banned user user_123",
    },
    {
      name: "unban",
      run: () => captured.run(() => unban("user_123", { yes: true })),
      message: "Unbanned user user_123",
    },
    {
      name: "lock",
      run: () => captured.run(() => lock("user_123", { yes: true })),
      message: "Locked user user_123",
    },
    {
      name: "unlock",
      run: () => captured.run(() => unlock("user_123", { yes: true })),
      message: "Unlocked user user_123",
    },
  ])("$name prints terse success in human mode", async ({ run, message }) => {
    mockIsAgent.mockReturnValue(false);

    await run();

    expect(captured.out).toBe("");
    expect(captured.err).toContain(message);
    expect(captured.err).not.toContain('"ok"');
  });

  test.each([
    { name: "delete", run: () => remove("user_123", { app: "app_123", dryRun: true }) },
    { name: "ban", run: () => ban("user_123", { app: "app_123", dryRun: true }) },
    { name: "unban", run: () => unban("user_123", { app: "app_123", dryRun: true }) },
    { name: "lock", run: () => lock("user_123", { app: "app_123", dryRun: true }) },
    { name: "unlock", run: () => unlock("user_123", { app: "app_123", dryRun: true }) },
  ])(
    "$name dry-run prints the request and resolved target without calling BAPI",
    async ({ name, run }) => {
      await captured.run(run);

      const expectedPath = name === "delete" ? "/v1/users/user_123" : `/v1/users/user_123/${name}`;

      expect(captured.err).toContain(
        `[dry-run] ${name === "delete" ? "DELETE" : "POST"} ${expectedPath} for My App (production)`,
      );
      expect(mockDescribeBapiTarget).toHaveBeenCalledWith(
        expect.objectContaining({
          app: "app_123",
          dryRun: true,
        }),
      );
      expect(captured.out).toBe("");
      expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
      expect(mockBapiRequest).not.toHaveBeenCalled();
    },
  );

  test("prints non-empty plain-text responses without JSON encoding", async () => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body: "deleted",
      rawBody: "deleted",
    });

    await captured.run(() => remove("user_123", { yes: true }));

    expect(captured.out).toBe("deleted");
  });

  test.each([
    { name: "empty string", body: "" },
    { name: "undefined", body: undefined },
  ])("prints nothing for effectively empty responses: $name", async ({ body }) => {
    mockBapiRequest.mockResolvedValue({
      status: 200,
      headers: new Headers(),
      body,
      rawBody: "",
    });

    await captured.run(() => remove("user_123", { yes: true }));

    expect(captured.out).toBe("");
  });

  test("prompts human users and aborts when confirmation is declined", async () => {
    mockIsAgent.mockReturnValue(false);
    mockConfirm.mockResolvedValue(false);

    const error = await captured.run(() => remove("user_123")).catch((error_: unknown) => error_);

    expect(error).toBeInstanceOf(UserAbortError);
    expect(captured.err).toContain("About to DELETE /users/user_123");
    expect(captured.err).toContain("permanently delete");
    expect(mockResolveBapiSecretKey).toHaveBeenCalledTimes(1);
    expect(mockBapiRequest).not.toHaveBeenCalled();
  });

  test("prints concise lifecycle BAPI errors to stderr in human mode", async () => {
    mockIsAgent.mockReturnValue(false);
    mockHandleBapiError.mockImplementation((error: unknown) => error instanceof BapiError);
    mockBapiRequest.mockRejectedValue(
      new BapiError(
        422,
        JSON.stringify({
          errors: [
            {
              code: "operation_not_allowed",
              message: "Cannot delete the last admin user",
            },
          ],
        }),
        new Headers(),
      ),
    );

    await captured.run(() => remove("user_123", { yes: true }));

    expect(process.exitCode).toBe(1);
    expect(captured.out).toBe("");
    expect(captured.err).toContain("Failed to delete user user_123");
    expect(captured.err).toContain("Cannot delete the last admin user");
  });

  test("cli registers lifecycle user commands with json output support", () => {
    const program = createProgram();
    const users = program.commands.find((command) => command.name() === "users")!;
    const optionNames = (name: string) =>
      users.commands
        .find((command) => command.name() === name)!
        .options.map((option) => option.long);

    for (const name of ["delete", "ban", "unban", "lock", "unlock"]) {
      expect(optionNames(name)).toEqual(
        expect.arrayContaining([
          "--json",
          "--secret-key",
          "--app",
          "--instance",
          "--dry-run",
          "--yes",
        ]),
      );
    }
  });
});
