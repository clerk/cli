import { test, expect, describe, beforeEach, mock } from "bun:test";
import { openDashboard, buildDashboardUrl } from "./index.ts";
import { testRoot } from "../../test/lib/test-root.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";
import type { Root } from "../../lib/deps.ts";

const PROFILE = {
  path: "/test/project",
  profile: {
    appId: "app_abc123",
    appName: "Test App",
    instances: { development: "ins_dev789" },
  },
};

function baseDeps(overrides: Parameters<typeof testRoot>[0] = {}): Root {
  return testRoot({
    configStore: { resolveProfile: async () => PROFILE },
    environment: { getDashboardUrl: () => "https://dashboard.clerk.com" },
    opener: { open: async () => ({ ok: true, launcher: "open" }) },
    mode: { isAgent: () => false, isHuman: () => true },
    ...overrides,
  });
}

function logCalls(fn: unknown): string {
  return (fn as ReturnType<typeof mock>).mock.calls.map((c) => String(c[0])).join("\n");
}

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
  test("builds URL without subpath", () => {
    const url = buildDashboardUrl("https://dashboard.clerk.com", "app_abc", "ins_xyz");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz");
  });

  test("appends subpath", () => {
    const url = buildDashboardUrl("https://dashboard.clerk.com", "app_abc", "ins_xyz", "users");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz/users");
  });

  test("strips leading and trailing slashes from subpath", () => {
    const url = buildDashboardUrl(
      "https://dashboard.clerk.com",
      "app_abc",
      "ins_xyz",
      "/api-keys/",
    );
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz/api-keys");
  });

  test("empty subpath behaves like no subpath", () => {
    const url = buildDashboardUrl("https://dashboard.clerk.com", "app_abc", "ins_xyz", "");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz");
  });

  test("strips trailing slash on host", () => {
    const url = buildDashboardUrl("https://dashboard.clerk.com/", "app_abc", "ins_xyz");
    expect(url).toBe("https://dashboard.clerk.com/apps/app_abc/instances/ins_xyz");
  });
});

describe("openDashboard", () => {
  let deps: Root;

  beforeEach(() => {
    deps = baseDeps();
  });

  test("human mode: prints arrow + app + dim URL, opens browser", async () => {
    await openDashboard(deps, undefined);

    const err = logCalls(deps.log.info);
    expect(err).toContain("Opening");
    expect(err).toContain("Test App");
    expect(err).toContain("development");
    expect(err).toContain("https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789");
    expect(deps.opener.open).toHaveBeenCalledTimes(1);
    expect(deps.opener.open).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
  });

  test("human mode with subpath: shows target in header", async () => {
    await openDashboard(deps, "users");

    const err = logCalls(deps.log.info);
    expect(err).toContain("→");
    expect(err).toContain("users");
  });

  test("--print: plain URL only on stdout, no browser", async () => {
    await openDashboard(deps, undefined, { print: true });

    expect(deps.log.data).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789",
    );
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  test("agent mode: emits structured JSON, no browser", async () => {
    deps = baseDeps({ mode: { isAgent: () => true, isHuman: () => false } });

    await openDashboard(deps, "users");

    const raw = (deps.log.data as ReturnType<typeof mock>).mock.calls[0]![0] as string;
    const payload = JSON.parse(raw);
    expect(payload).toEqual({
      url: "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/users",
      appId: "app_abc123",
      appName: "Test App",
      instanceId: "ins_dev789",
      instanceLabel: "development",
      subpath: "users",
      opened: false,
    });
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  test("agent mode without subpath: subpath is null in JSON", async () => {
    deps = baseDeps({ mode: { isAgent: () => true, isHuman: () => false } });

    await openDashboard(deps, undefined);

    const raw = (deps.log.data as ReturnType<typeof mock>).mock.calls[0]![0] as string;
    const payload = JSON.parse(raw);
    expect(payload.subpath).toBeNull();
  });

  test("multi-segment known path (platform/api-keys) does not warn", async () => {
    await openDashboard(deps, "platform/api-keys", { print: true });

    expect(deps.log.warn).not.toHaveBeenCalled();
    expect(deps.log.data).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/platform/api-keys",
    );
  });

  test("known subpath does not warn", async () => {
    await openDashboard(deps, "users", { print: true });
    expect(deps.log.warn).not.toHaveBeenCalled();
  });

  test("unknown subpath warns but still emits URL", async () => {
    await openDashboard(deps, "not-a-real-page", { print: true });

    expect(logCalls(deps.log.warn)).toContain("not a known dashboard path");
    expect(deps.log.data).toHaveBeenCalledWith(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/not-a-real-page",
    );
  });

  test("throws NOT_LINKED when no profile", async () => {
    deps = baseDeps({ configStore: { resolveProfile: async () => undefined } });

    await expect(openDashboard(deps, undefined)).rejects.toThrow(/clerk link/);
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  test("throws INSTANCE_NOT_FOUND when development instance missing", async () => {
    deps = baseDeps({
      configStore: {
        resolveProfile: async () => ({
          path: "/test/project",
          profile: { appId: "app_abc123", instances: {} },
        }),
      },
    });

    await expect(openDashboard(deps, undefined)).rejects.toThrow(/development instance/);
    expect(deps.opener.open).not.toHaveBeenCalled();
  });

  test("warns when opener fails", async () => {
    deps = baseDeps({
      opener: { open: async () => ({ ok: false, reason: "no-launcher" }) },
    });

    await openDashboard(deps, undefined);

    expect(logCalls(deps.log.warn)).toContain("Could not open your browser");
  });
});
