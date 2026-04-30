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
});
