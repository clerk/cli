import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";
import { captureLog } from "../../test/lib/stubs.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";

const mockResolveProfile = mock();
const mockOpenBrowser = mock();

mock.module("../../lib/config.ts", () => ({
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

mock.module("../../lib/open.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
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

describe("isKnownDashboardPath", () => {
  test("matches single-segment known path", () => {
    expect(isKnownDashboardPath("users")).toBe(true);
    expect(isKnownDashboardPath("api-keys")).toBe(true);
  });

  test("matches deep paths under single-segment known path", () => {
    expect(isKnownDashboardPath("users/user_xxx")).toBe(true);
  });

  test("matches multi-segment known path exactly", () => {
    expect(isKnownDashboardPath("platform/api-keys")).toBe(true);
  });

  test("rejects unknown paths", () => {
    expect(isKnownDashboardPath("not-a-real-page")).toBe(false);
    expect(isKnownDashboardPath("platform/unknown")).toBe(false);
  });
});

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
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    setMode("human");
    setCurrentEnv("production");
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
    captured = captureLog();
  });

  afterEach(() => {
    captured.teardown();
    mockResolveProfile.mockReset();
    mockOpenBrowser.mockReset();
  });

  test("human mode: prints arrow + app + dim URL, opens browser", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await captured.run(() => openDashboard(undefined));

    expect(captured.err).toContain("Opening");
    expect(captured.err).toContain("Test App");
    expect(captured.err).toContain("development");
    expect(captured.err).toContain(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
    expect(mockOpenBrowser).toHaveBeenCalledTimes(1);
    expect(mockOpenBrowser).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
  });

  test("human mode with subpath: shows target in header", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await captured.run(() => openDashboard("users"));

    expect(captured.err).toContain("→");
    expect(captured.err).toContain("users");
  });

  test("--print: plain URL only on stdout, no browser", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await captured.run(() => openDashboard(undefined, { print: true }));

    expect(captured.out).toBe("https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789");
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode: emits structured JSON, no browser", async () => {
    setMode("agent");
    mockResolveProfile.mockResolvedValue(PROFILE);

    await captured.run(() => openDashboard("users"));

    const payload = JSON.parse(captured.out);
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

    await captured.run(() => openDashboard(undefined));

    const payload = JSON.parse(captured.out);
    expect(payload.subpath).toBeNull();
  });

  test("multi-segment known path (platform/api-keys) does not warn", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await captured.run(() => openDashboard("platform/api-keys", { print: true }));

    expect(captured.err).not.toContain("not a known dashboard path");
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/platform/api-keys",
    );
  });

  test("known subpath does not warn", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await captured.run(() => openDashboard("users", { print: true }));

    expect(captured.err).not.toContain("not a known dashboard path");
  });

  test("unknown subpath warns to stderr but still emits URL", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await captured.run(() => openDashboard("not-a-real-page", { print: true }));

    expect(captured.err).toContain("not a known dashboard path");
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/not-a-real-page",
    );
  });

  test("throws NOT_LINKED when no profile", async () => {
    mockResolveProfile.mockResolvedValue(null);

    await expect(captured.run(() => openDashboard(undefined))).rejects.toThrow(/clerk link/);
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

    await expect(captured.run(() => openDashboard(undefined))).rejects.toThrow(
      /development instance/,
    );
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });
});
