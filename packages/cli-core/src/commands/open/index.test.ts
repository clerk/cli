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

  test("builds production URL", () => {
    setCurrentEnv("production");
    const url = buildDashboardUrl("app_abc", "ins_xyz");
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

    await openDashboard();

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

    await openDashboard({ print: true });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode prints URL but does not open browser", async () => {
    setMode("agent");
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard();

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("throws NOT_LINKED when no profile", async () => {
    mockResolveProfile.mockResolvedValue(null);

    await expect(openDashboard()).rejects.toThrow(/clerk link/);
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

    await expect(openDashboard()).rejects.toThrow(/development instance/);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });
});
