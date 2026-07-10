import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveAppContext = mock();
const mockResolveProfile = mock();
const mockResolveInstanceId = mock();
mock.module("../../lib/config.ts", () => ({
  resolveAppContext: (...args: unknown[]) => mockResolveAppContext(...args),
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
  resolveInstanceId: (...args: unknown[]) => mockResolveInstanceId(...args),
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
  formatTargetSuffix: (label?: string) => (label ? ` · on ${label}` : ""),
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
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
  const captured = useCaptureLog();

  beforeEach(() => {
    setMode("human");
    setCurrentEnv("production");
    mockResolveAppContext.mockResolvedValue({
      appId: CTX.appId,
      appLabel: CTX.appLabel,
      instanceId: CTX.instanceId,
      instanceLabel: CTX.instanceLabel,
    });
    mockResolveProfile.mockResolvedValue(undefined);
    mockResolveInstanceId.mockReturnValue({
      id: CTX.instanceId,
      label: CTX.instanceLabel,
    });
    mockResolveUsersInstanceContext.mockResolvedValue(CTX);
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
  });

  afterEach(() => {
    mockResolveAppContext.mockReset();
    mockResolveProfile.mockReset();
    mockResolveInstanceId.mockReset();
    mockResolveUsersInstanceContext.mockReset();
    mockPickUser.mockReset();
    mockOpenBrowser.mockReset();
  });

  test("explicit user-id + linked profile: opens dashboard URL for that user", async () => {
    await open({ userId: "user_2x9k" });

    expect(mockResolveAppContext).toHaveBeenCalledWith({
      instance: undefined,
    });
    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
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
    await open({ userId: "user_2x9k", print: true });

    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
    );
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode without --print: emits structured JSON, no browser", async () => {
    setMode("agent");

    await open({ userId: "user_2x9k" });

    const payload = JSON.parse(captured.out);
    expect(payload).toEqual({
      url: "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
      appId: "app_abc123",
      appName: "My App",
      instanceId: "ins_prod789",
      instanceLabel: "production",
      userId: "user_2x9k",
    });
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode with --print still wins: URL only, no JSON", async () => {
    setMode("agent");

    await open({ userId: "user_2x9k", print: true });

    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
    );
    expect(() => JSON.parse(captured.out)).toThrow();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("--secret-key alone: uses linked app context and direct BAPI auth", async () => {
    await open({ secretKey: "sk_test_loose", userId: "user_2x9k", print: true });

    expect(mockResolveAppContext).toHaveBeenCalledWith({
      instance: undefined,
    });
    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_2x9k",
    );
  });

  test("--secret-key without a resolvable dashboard target: throws usage error", async () => {
    setMode("agent");
    const { CliError, ERROR_CODE } = await import("../../lib/errors.ts");
    mockResolveAppContext.mockRejectedValueOnce(
      new CliError("Not linked.", {
        code: ERROR_CODE.NOT_LINKED,
      }),
    );
    mockResolveUsersInstanceContext
      .mockRejectedValueOnce(
        new CliError("Not linked.", {
          code: ERROR_CODE.NOT_LINKED,
        }),
      )
      .mockResolvedValueOnce({
        secretKey: "sk_test_loose",
      });

    await expect(open({ secretKey: "sk_test_loose", userId: "user_2x9k" })).rejects.toThrow(
      /dashboard URL|--app/,
    );
    expect(mockResolveUsersInstanceContext).toHaveBeenCalledTimes(2);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("forwards --branch to the resolver on the --secret-key catch fallback", async () => {
    setMode("agent");
    const { CliError, ERROR_CODE } = await import("../../lib/errors.ts");
    mockResolveAppContext.mockRejectedValueOnce(
      new CliError("Not linked.", {
        code: ERROR_CODE.NOT_LINKED,
      }),
    );
    mockResolveUsersInstanceContext
      .mockRejectedValueOnce(
        new CliError("Not linked.", {
          code: ERROR_CODE.NOT_LINKED,
        }),
      )
      .mockResolvedValueOnce(CTX);

    await open({
      secretKey: "sk_test_loose",
      userId: "user_2x9k",
      branch: "agent/pr-42",
      print: true,
    });

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledTimes(2);
    expect(mockResolveUsersInstanceContext).toHaveBeenNthCalledWith(2, {
      secretKey: "sk_test_loose",
      app: undefined,
      instance: undefined,
      branch: "agent/pr-42",
    });
  });

  test("no user-id + human mode: invokes pickUser and uses returned id", async () => {
    mockPickUser.mockResolvedValue("user_picked");

    await open({ print: true });

    expect(mockPickUser).toHaveBeenCalledWith({
      secretKey: CTX.secretKey,
      message: "Pick a user to open in the dashboard:",
    });
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_prod789/users/user_picked",
    );
  });

  test("no user-id + agent mode: throws usage error, does not invoke pickUser", async () => {
    setMode("agent");

    await expect(open({})).rejects.toThrow(/User ID is required/);
    expect(mockPickUser).not.toHaveBeenCalled();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("--branch + --app matching the linked profile: bypasses the branch-blind resolveInstanceId early return", async () => {
    mockResolveProfile.mockResolvedValue({
      profile: { appId: "app_abc123", appName: "My App" },
    });

    await open({
      userId: "user_2x9k",
      app: "app_abc123",
      branch: "agent/pr-42",
      print: true,
    });

    expect(mockResolveInstanceId).not.toHaveBeenCalled();
    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_abc123",
      instance: undefined,
      branch: "agent/pr-42",
    });
  });

  test("forwards --app and --instance to the resolver", async () => {
    mockResolveProfile.mockResolvedValue(undefined);

    await open({ userId: "user_2x9k", app: "app_other", instance: "prod", print: true });

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_other",
      instance: "prod",
    });
  });

  test("forwards --branch to resolveAppContext on the known-user path", async () => {
    mockResolveProfile.mockResolvedValue(undefined);

    await open({ userId: "user_2x9k", branch: "agent/pr-42", print: true });

    expect(mockResolveAppContext).toHaveBeenCalledWith({
      instance: undefined,
      branch: "agent/pr-42",
    });
  });

  test("forwards --branch to the resolver alongside --app and --instance", async () => {
    mockResolveProfile.mockResolvedValue(undefined);

    await open({
      userId: "user_2x9k",
      app: "app_other",
      instance: "prod",
      branch: "agent/pr-42",
      print: true,
    });

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_other",
      instance: "prod",
      branch: "agent/pr-42",
    });
  });

  test("forwards --branch to the resolver on the pick-user path (no --user-id)", async () => {
    mockPickUser.mockResolvedValue("user_picked");

    await open({ branch: "agent/pr-42", print: true });

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      secretKey: undefined,
      app: undefined,
      instance: undefined,
      branch: "agent/pr-42",
    });
  });

  test("accepts --secret-key combined with --app and --instance", async () => {
    mockResolveProfile.mockResolvedValue(undefined);
    mockResolveUsersInstanceContext.mockReset();
    mockResolveUsersInstanceContext
      .mockRejectedValueOnce(new Error("Not authenticated"))
      .mockResolvedValueOnce(CTX);

    await open({
      userId: "user_2x9k",
      print: true,
      secretKey: "sk_test_direct",
      app: "app_other",
      instance: "prod",
    });

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_other",
      instance: "prod",
    });
    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      secretKey: "sk_test_direct",
      app: "app_other",
      instance: "prod",
    });
  });

  test("propagates NOT_LINKED when resolver throws (agent mode, no targeting)", async () => {
    setMode("agent");
    const { CliError, ERROR_CODE } = await import("../../lib/errors.ts");
    mockResolveAppContext.mockRejectedValueOnce(
      new CliError("Not linked.", {
        code: ERROR_CODE.NOT_LINKED,
      }),
    );
    mockResolveUsersInstanceContext.mockRejectedValueOnce(
      new CliError("Not linked.", {
        code: ERROR_CODE.NOT_LINKED,
      }),
    );

    await expect(open({ userId: "user_2x9k" })).rejects.toThrow(/Not linked/);
  });

  test("registers an action in the users registry", async () => {
    const { listUsersActions } = await import("./registry.ts");
    const actions = listUsersActions();
    const action = actions.find((a) => a.key === "open");
    expect(action).toBeDefined();
    expect(action?.label).toBe("Open user in dashboard");
  });

  test("rejects malformed user IDs with a usage error", async () => {
    await expect(open({ userId: "../foo", print: true })).rejects.toThrow(/Invalid user ID/);

    await expect(open({ userId: "not-a-user-id", print: true })).rejects.toThrow(/Invalid user ID/);

    expect(mockResolveUsersInstanceContext).not.toHaveBeenCalled();
  });
});
