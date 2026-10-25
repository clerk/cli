import { test, expect, describe, afterAll, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";
import { configStubs, keylessTargetStubs, useCaptureLog } from "../../test/lib/stubs.ts";

const mockResolveAppContext = mock();
const mockResolveProfile = mock();
const mockResolveInstanceId = mock();
// Spread the full stub set: a partial module mock only stays valid while
// nothing else in the import graph reaches for the exports it left out.
mock.module("../../lib/config.ts", () => ({
  ...configStubs,
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

const mockResolveKeylessTarget = mock();
mock.module("../../lib/keyless-target.ts", () => ({
  ...keylessTargetStubs,
  resolveKeylessTarget: (...args: unknown[]) => mockResolveKeylessTarget(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  withSpinner: (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

const { open } = await import("./open.ts");
const unlinkedFolder = await import("../../lib/unlinked-folder.ts");

// What the folder holds, for the refusal: never the real working directory or
// credential store.
const readUnlinkedFolderSpy = spyOn(unlinkedFolder, "readUnlinkedFolder").mockResolvedValue({
  kind: "init_app",
  credential: "session",
});
afterAll(() => readUnlinkedFolderSpy.mockRestore());

// No stored session, read from the token override instead of the keychain.
const { _setTokenOverride } = await import("../../lib/credential-store.ts");
_setTokenOverride(null);
afterAll(() => _setTokenOverride(undefined));

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
    mockResolveKeylessTarget.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockResolveAppContext.mockReset();
    mockResolveProfile.mockReset();
    mockResolveInstanceId.mockReset();
    mockResolveUsersInstanceContext.mockReset();
    mockPickUser.mockReset();
    mockOpenBrowser.mockReset();
    mockResolveKeylessTarget.mockReset();
  });

  describe("on an unclaimed keyless application", () => {
    beforeEach(() => {
      // Nothing linked and no account context — the state `clerk init` leaves
      // behind before anyone claims the app.
      mockResolveAppContext.mockRejectedValue(
        new Error("No Clerk project linked to this directory."),
      );
      mockResolveKeylessTarget.mockResolvedValue({
        secretKey: "sk_test_keyless",
        source: ".env.local",
      });
    });

    beforeEach(() => {
      readUnlinkedFolderSpy.mockResolvedValue({ kind: "init_app", credential: "session" });
    });

    test("says the application is unclaimed rather than that nothing is linked", async () => {
      await expect(open({ userId: "user_abc" })).rejects.toThrow(
        /unclaimed accountless application \(secret key from \.env\.local\).*no Dashboard page/s,
      );
    });

    test("gives the claim step, then the rerun, and a command that works right now", async () => {
      const error = await open({ userId: "user_abc" }).catch((thrown: unknown) => thrown);
      const message = (error as Error).message;
      expect(message).toContain(
        "Run `clerk link`: it claims the app into your account and links this folder. Then run `clerk users open user_abc` again.",
      );
      // `clerk users get` does not exist; `clerk api` is the reader that does.
      expect(message).toContain("clerk api /users/user_abc");
    });

    // Plain keys may belong to an app already in an account.
    test("plain keys: says the folder isn't linked, never unclaimed, and finds the app by key", async () => {
      readUnlinkedFolderSpy.mockResolvedValue({
        kind: "unknown_owner",
        credential: "session",
        publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env.local" },
      });

      const error = await open({ userId: "user_abc" }).catch((thrown: unknown) => thrown);
      const message = (error as Error).message;
      expect(message).toContain(
        "This directory isn't linked, so the CLI doesn't know the ID of the application the secret key from .env.local belongs to",
      );
      expect(message).toContain("Run `clerk link`: it finds the app in your account by that key.");
      expect(message).not.toContain("unclaimed");
    });

    test("does not hijack an explicit --app target", async () => {
      // Naming an application says the user isn't asking about the keyless one
      // sitting in this directory, so that resolution must run untouched.
      await open({ userId: "user_abc", app: "app_other", print: true });

      expect(mockResolveKeylessTarget).not.toHaveBeenCalled();
      expect(captured.out).toContain(`/apps/${CTX.appId}`);
    });
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

  test("forwards --app and --instance to the resolver", async () => {
    mockResolveProfile.mockResolvedValue(undefined);

    await open({ userId: "user_2x9k", app: "app_other", instance: "prod", print: true });

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      app: "app_other",
      instance: "prod",
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
