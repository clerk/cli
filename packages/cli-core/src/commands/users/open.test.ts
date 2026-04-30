import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";
import { captureLog } from "../../test/lib/stubs.ts";

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
  instanceId: "ins_dev789",
};

describe("users open", () => {
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    setMode("human");
    setCurrentEnv("production");
    mockResolveUsersInstanceContext.mockResolvedValue(CTX);
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockResolveUsersInstanceContext.mockReset();
    mockPickUser.mockReset();
    mockOpenBrowser.mockReset();
  });

  test("explicit user-id + linked profile: opens dashboard URL for that user", async () => {
    await captured.run(() => open({ userId: "user_2x9k" }));

    expect(mockResolveUsersInstanceContext).toHaveBeenCalledWith({
      secretKey: undefined,
      app: undefined,
      instance: undefined,
    });
    expect(mockPickUser).not.toHaveBeenCalled();
    expect(mockOpenBrowser).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/users/user_2x9k",
    );
    expect(captured.err).toContain("Opening");
    expect(captured.err).toContain("users/user_2x9k");
  });

  test("--print: plain URL only on stdout, no browser, no intro/outro", async () => {
    await captured.run(() => open({ userId: "user_2x9k", print: true }));

    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/users/user_2x9k",
    );
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode without --print: emits structured JSON, no browser", async () => {
    setMode("agent");

    await captured.run(() => open({ userId: "user_2x9k" }));

    const payload = JSON.parse(captured.out);
    expect(payload).toEqual({
      url: "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/users/user_2x9k",
      appId: "app_abc123",
      appName: null,
      instanceId: "ins_dev789",
      instanceLabel: "development",
      userId: "user_2x9k",
      opened: false,
    });
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode with --print still wins: URL only, no JSON", async () => {
    setMode("agent");

    await captured.run(() => open({ userId: "user_2x9k", print: true }));

    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/users/user_2x9k",
    );
    expect(() => JSON.parse(captured.out)).toThrow();
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("--secret-key alone: throws usage error pointing to --app", async () => {
    mockResolveUsersInstanceContext.mockResolvedValue({ secretKey: "sk_test_loose" });

    await expect(
      captured.run(() => open({ secretKey: "sk_test_loose", userId: "user_2x9k" })),
    ).rejects.toThrow(/--app/);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });
});
