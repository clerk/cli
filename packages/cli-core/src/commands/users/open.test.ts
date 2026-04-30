import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";
import { captureLog } from "../../test/lib/stubs.ts";

const mockResolveBapiSecretKey = mock();
mock.module("../../lib/bapi-command.ts", () => ({
  resolveBapiSecretKey: (...args: unknown[]) => mockResolveBapiSecretKey(...args),
}));

const mockResolveUsersInstanceContext = mock();
mock.module("./interactive/instance-context.ts", () => ({
  resolveUsersInstanceContext: (...args: unknown[]) => mockResolveUsersInstanceContext(...args),
}));

const mockPickUser = mock();
mock.module("./interactive/pick-user.ts", () => ({
  pickUser: (...args: unknown[]) => mockPickUser(...args),
}));

const mockOpenBrowser = mock();
mock.module("../../lib/open.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  withSpinner: (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { open } = await import("./open.ts");

const CTX = {
  secretKey: "sk_test_123",
  appId: "app_abc123",
  appLabel: "My App",
  instanceId: "ins_prod789",
  instanceLabel: "production",
};

describe("users open", () => {
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    setMode("human");
    setCurrentEnv("production");
    mockResolveUsersInstanceContext.mockResolvedValue(CTX);
    mockResolveBapiSecretKey.mockResolvedValue("sk_test_resolved");
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockResolveBapiSecretKey.mockReset();
    mockResolveUsersInstanceContext.mockReset();
    mockPickUser.mockReset();
    mockOpenBrowser.mockReset();
  });

  test("explicit user-id + linked profile: opens dashboard URL for that user", async () => {
    await captured.run(() => open({ userId: "user_2x9k" }));

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: undefined,
      instance: undefined,
    });
    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: undefined,
      app: undefined,
      instance: undefined,
    });
    expect(mockPickUser).not.toHaveBeenCalled();
    expect(mockOpenBrowser).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
    );
    expect(captured.err).toContain("Opening");
    expect(captured.err).toContain("users/user_2x9k");
    expect(captured.err).toContain("My App");
    expect(captured.err).toContain("(production)");
  });

  test("--print: plain URL only on stdout, no browser, no intro/outro", async () => {
    await captured.run(() => open({ userId: "user_2x9k", print: true }));

    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
    );
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode without --print: emits structured JSON, no browser", async () => {
    setMode("agent");

    await captured.run(() => open({ userId: "user_2x9k" }));

    const payload = JSON.parse(captured.out);
    expect(payload).toEqual({
      url: "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
      appId: "app_abc123",
      appName: "My App",
      instanceId: "ins_prod789",
      instanceLabel: "production",
      userId: "user_2x9k",
      opened: false,
    });
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode with --print still wins: URL only, no JSON", async () => {
    setMode("agent");

    await captured.run(() => open({ userId: "user_2x9k", print: true }));

    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
    );
    expect(() => JSON.parse(captured.out)).toThrow();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("--secret-key alone: uses linked app context and direct BAPI auth", async () => {
    await captured.run(() =>
      open({ secretKey: "sk_test_loose", userId: "user_2x9k", print: true }),
    );

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: undefined,
      instance: undefined,
    });
    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_loose",
      app: undefined,
      instance: undefined,
    });
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
    );
  });

  test("--secret-key without a resolvable dashboard target: throws usage error", async () => {
    setMode("agent");
    mockResolveUsersInstanceContext.mockRejectedValue(
      new (await import("../../lib/errors.ts")).CliError("Not linked.", {
        code: (await import("../../lib/errors.ts")).ERROR_CODE.NOT_LINKED,
      }),
    );

    await expect(
      captured.run(() => open({ secretKey: "sk_test_loose", userId: "user_2x9k" })),
    ).rejects.toThrow(/dashboard URL|--app/);
    expect(mockResolveBapiSecretKey).not.toHaveBeenCalled();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("no user-id + human mode: invokes pickUser and uses returned id", async () => {
    mockPickUser.mockResolvedValue("user_picked");

    await captured.run(() => open({ print: true }));

    expect(mockPickUser).toHaveBeenCalledWith({
      secretKey: "sk_test_resolved",
      message: "Pick a user to open in the dashboard:",
    });
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_picked",
    );
  });

  test("no user-id + agent mode: throws usage error, does not invoke pickUser", async () => {
    setMode("agent");

    await expect(captured.run(() => open({}))).rejects.toThrow(/User ID is required/);
    expect(mockPickUser).not.toHaveBeenCalled();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("forwards --app and --instance to the resolver", async () => {
    await captured.run(() =>
      open({ userId: "user_2x9k", app: "app_other", instance: "prod", print: true }),
    );

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_other",
      instance: "prod",
    });
    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: undefined,
      app: "app_other",
      instance: "prod",
    });
  });

  test("accepts --secret-key combined with --app and --instance", async () => {
    await captured.run(() =>
      open({
        userId: "user_2x9k",
        print: true,
        secretKey: "sk_test_direct",
        app: "app_other",
        instance: "prod",
      }),
    );

    expect(mockResolveBapiSecretKey).toHaveBeenCalledWith({
      secretKey: "sk_test_direct",
      app: "app_other",
      instance: "prod",
    });
    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_other",
      instance: "prod",
    });
  });

  test("propagates NOT_LINKED when resolver throws (agent mode, no targeting)", async () => {
    setMode("agent");
    mockResolveUsersInstanceContext.mockRejectedValue(
      new (await import("../../lib/errors.ts")).CliError("Not linked.", {
        code: (await import("../../lib/errors.ts")).ERROR_CODE.NOT_LINKED,
      }),
    );

    await expect(captured.run(() => open({ userId: "user_2x9k" }))).rejects.toThrow(/Not linked/);
  });

  test("registers an action in the users registry", async () => {
    const { listUsersActions } = await import("./registry.ts");
    const actions = listUsersActions();
    const action = actions.find((a) => a.key === "open");
    expect(action).toBeDefined();
    expect(action?.label).toBe("Open user in dashboard");
  });
});
