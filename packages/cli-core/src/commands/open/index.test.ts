import { test, expect, describe, afterEach, beforeEach, mock, spyOn } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";

const mockResolveProfile = mock();
const mockOpenBrowser = mock();

mock.module("../../lib/config.ts", () => ({
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

mock.module("../../lib/open.ts", () => ({
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
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
  });

  afterEach(() => {
    mockResolveProfile.mockReset();
    mockOpenBrowser.mockReset();
    consoleSpy?.mockRestore();
  });

  test("human mode: prints arrow + app + dim URL, opens browser", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard(undefined);

    expect(consoleSpy).toHaveBeenCalledTimes(2);
    const firstLine = consoleSpy.mock.calls[0]?.[0] as string;
    const secondLine = consoleSpy.mock.calls[1]?.[0] as string;
    expect(firstLine).toContain("Opening");
    expect(firstLine).toContain("Test App");
    expect(firstLine).toContain("development");
    expect(secondLine).toContain(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
    expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowser).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
  });

  test("human mode with subpath: shows target in header", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard("users");

    const firstLine = consoleSpy.mock.calls[0]?.[0] as string;
    expect(firstLine).toContain("→");
    expect(firstLine).toContain("users");
  });

  test("--print: plain URL only on stdout, no browser", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard(undefined, { print: true });

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    expect(consoleSpy).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode: emits structured JSON, no browser", async () => {
    setMode("agent");
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard("users");

    expect(consoleSpy).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string);
    expect(payload).toEqual({
      url: "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/users",
      appId: "app_abc123",
      appName: "Test App",
      instanceId: "ins_dev789",
      instanceLabel: "development",
      subpath: "users",
      opened: false,
    });
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode without subpath: subpath is null in JSON", async () => {
    setMode("agent");
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});

    await openDashboard(undefined);

    const payload = JSON.parse(consoleSpy.mock.calls[0]?.[0] as string);
    expect(payload.subpath).toBeNull();
  });

  test("known subpath does not warn", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    const errSpy = spyOn(console, "error").mockImplementation(() => {});

    await openDashboard("users", { print: true });

    expect(errSpy).not.toHaveBeenCalled();
    errSpy.mockRestore();
  });

  test("unknown subpath warns to stderr but still emits URL", async () => {
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
