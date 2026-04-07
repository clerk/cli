import { test, expect, describe, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";

const mockResolveProfile = mock();
const mockOpenBrowser = mock();

mock.module("../../lib/config.ts", () => ({
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

mock.module("../../lib/browser.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

const { openDashboard, buildDashboardUrl } = await import("./index.ts");

const PROFILE = {
  path: "/test/project",
  profile: {
    appId: "app_abc123",
    appName: "Test App",
    instances: { development: "ins_dev789" },
  },
};

describe("buildDashboardUrl", () => {
  beforeEach(() => {
    setCurrentEnv("production");
  });

  test("builds production URL without subpath", () => {
    const url = buildDashboardUrl("app_abc", "ins_xyz");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz");
  });

  test("appends subpath", () => {
    const url = buildDashboardUrl("app_abc", "ins_xyz", "users");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz/users");
  });

  test("strips leading and trailing slashes from subpath", () => {
    const url = buildDashboardUrl("app_abc", "ins_xyz", "/api-keys/");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz/api-keys");
  });

  test("empty subpath behaves like no subpath", () => {
    const url = buildDashboardUrl("app_abc", "ins_xyz", "");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz");
  });
});

describe("openDashboard", () => {
  let consoleSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    setMode("human");
    setCurrentEnv("production");
  });

  afterEach(() => {
    mockResolveProfile.mockReset();
    mockOpenBrowser.mockReset();
    consoleSpy?.mockRestore();
  });

  test("prints URL and opens browser when human + linked", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard(undefined);

    expect(consoleSpy).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
    expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowser).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
  });

  test("--print prints URL but does not open browser", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard(undefined, { print: true });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode prints URL but does not open browser", async () => {
    setMode("agent");
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard(undefined);

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("known subpath builds the correct URL without warning", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await openDashboard("users", { print: true });

    expect(consoleSpy).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/users",
    );
    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("unknown subpath warns to stderr but still prints URL", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await openDashboard("not-a-real-page", { print: true });

    expect(errSpy).toHaveBeenCalledTimes(1);
    expect(errSpy.mock.calls[0]?.[0]).toContain("not a known dashboard path");
    expect(consoleSpy).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/not-a-real-page",
    );
    errSpy.mockRestore();
  });

  test("throws NOT_LINKED when no profile", async () => {
    mockResolveProfile.mockResolvedValue(null);

    await expect(openDashboard(undefined)).rejects.toThrow(/clerk link/);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("throws INSTANCE_NOT_FOUND when development instance missing", async () => {
    mockResolveProfile.mockResolvedValue({
      path: "/test/project",
      profile: {
        appId: "app_abc123",
        instances: {},
      },
    });

    await expect(openDashboard(undefined)).rejects.toThrow(/development instance/);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });
});
