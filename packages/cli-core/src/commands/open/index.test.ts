import { test, expect, describe, afterEach, beforeEach, mock } from "bun:test";
import { setMode } from "../../mode.ts";
import { setCurrentEnv } from "../../lib/environment.ts";
import { configStubs, keylessTargetStubs, useCaptureLog } from "../../test/lib/stubs.ts";
import { isKnownDashboardPath } from "./dashboard-paths.ts";

const mockResolveProfile = mock();
const mockOpenBrowser = mock();
const mockResolveKeylessTarget = mock();
const mockFindKeylessClaimUrl = mock();
const mockDescribeKeylessInstance = mock();

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

mock.module("../../lib/open.ts", () => ({
  openBrowser: (...args: unknown[]) => mockOpenBrowser(...args),
}));

mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
}));

mock.module("../../lib/keyless-target.ts", () => ({
  ...keylessTargetStubs,
  resolveKeylessTarget: (...args: unknown[]) => mockResolveKeylessTarget(...args),
}));

mock.module("./keyless-claim.ts", () => ({
  findKeylessClaimUrl: (...args: unknown[]) => mockFindKeylessClaimUrl(...args),
  describeKeylessInstance: (...args: unknown[]) => mockDescribeKeylessInstance(...args),
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
  const captured = useCaptureLog();

  beforeEach(() => {
    setMode("human");
    setCurrentEnv("production");
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
    // Default to "no keyless application on disk either" so the pre-existing
    // not-linked tests exercise the fully-empty case, not the keyless branch.
    mockFindKeylessClaimUrl.mockResolvedValue(undefined);
    mockResolveKeylessTarget.mockResolvedValue(undefined);
  });

  afterEach(() => {
    mockResolveProfile.mockReset();
    mockOpenBrowser.mockReset();
    mockResolveKeylessTarget.mockReset();
    mockFindKeylessClaimUrl.mockReset();
    mockDescribeKeylessInstance.mockReset();
  });

  test("human mode: prints arrow + app + dim URL, opens browser", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await openDashboard(undefined);

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

    await openDashboard("users");

    expect(captured.err).toContain("→");
    expect(captured.err).toContain("users");
  });

  test("--print: plain URL only on stdout, no browser", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await openDashboard(undefined, { print: true });

    expect(captured.out).toBe("https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789");
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode: emits structured JSON, no browser", async () => {
    setMode("agent");
    mockResolveProfile.mockResolvedValue(PROFILE);

    await openDashboard("users");

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

    await openDashboard(undefined);

    const payload = JSON.parse(captured.out);
    expect(payload.subpath).toBeNull();
  });

  test("multi-segment known path (platform/api-keys) does not warn", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await openDashboard("platform/api-keys", { print: true });

    expect(captured.err).not.toContain("not a known dashboard path");
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/platform/api-keys",
    );
  });

  test("known subpath does not warn", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await openDashboard("users", { print: true });

    expect(captured.err).not.toContain("not a known dashboard path");
  });

  test("unknown subpath warns to stderr but still emits URL", async () => {
    mockResolveProfile.mockResolvedValue(PROFILE);

    await openDashboard("not-a-real-page", { print: true });

    expect(captured.err).toContain("not a known dashboard path");
    expect(captured.out).toBe(
      "https://dashboard.clerk.com/apps/app_abc123/instances/ins_dev789/not-a-real-page",
    );
  });

  test("throws NOT_LINKED when no profile and no keyless application either", async () => {
    mockResolveProfile.mockResolvedValue(null);

    await expect(openDashboard(undefined)).rejects.toThrow(/clerk link.*clerk init/is);
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

describe("openDashboard: unclaimed keyless application", () => {
  const captured = useCaptureLog();

  const CLAIM_DESTINATION = {
    url: "https://dashboard.clerk.com/apps/claim?token=abc123",
    source: ".clerk/keyless.json",
  };

  beforeEach(() => {
    setMode("human");
    setCurrentEnv("production");
    mockOpenBrowser.mockResolvedValue({ ok: true, launcher: "open" });
    mockResolveProfile.mockResolvedValue(null);
    mockDescribeKeylessInstance.mockResolvedValue({
      instanceId: "ins_keyless123",
      environmentType: "development",
    });
  });

  afterEach(() => {
    mockResolveProfile.mockReset();
    mockOpenBrowser.mockReset();
    mockResolveKeylessTarget.mockReset();
    mockFindKeylessClaimUrl.mockReset();
    mockDescribeKeylessInstance.mockReset();
  });

  test("human mode: opens the claim link, not a dashboard deep-link", async () => {
    mockFindKeylessClaimUrl.mockResolvedValue(CLAIM_DESTINATION);
    mockResolveKeylessTarget.mockResolvedValue({ secretKey: "sk_test_x", source: ".env" });

    await openDashboard(undefined);

    expect(captured.err).toContain("hasn't been claimed");
    expect(captured.err).toContain("ins_keyless123");
    expect(captured.err).toContain(CLAIM_DESTINATION.url);
    expect(mockOpenBrowser).toHaveBeenCalledWith(CLAIM_DESTINATION.url);
  });

  test("--print: prints only the claim URL, no browser", async () => {
    mockFindKeylessClaimUrl.mockResolvedValue(CLAIM_DESTINATION);
    mockResolveKeylessTarget.mockResolvedValue({ secretKey: "sk_test_x", source: ".env" });

    await openDashboard(undefined, { print: true });

    expect(captured.out).toBe(CLAIM_DESTINATION.url);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("agent mode: emits structured JSON with keyless: true, no browser", async () => {
    setMode("agent");
    mockFindKeylessClaimUrl.mockResolvedValue(CLAIM_DESTINATION);
    mockResolveKeylessTarget.mockResolvedValue({ secretKey: "sk_test_x", source: ".env" });

    await openDashboard(undefined);

    const payload = JSON.parse(captured.out);
    expect(payload).toEqual({
      url: CLAIM_DESTINATION.url,
      keyless: true,
      claimSource: CLAIM_DESTINATION.source,
      instanceId: "ins_keyless123",
      environmentType: "development",
      subpath: null,
      opened: false,
    });
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("a bad secret key on disk doesn't block the claim link — instance details just come back null", async () => {
    mockFindKeylessClaimUrl.mockResolvedValue(CLAIM_DESTINATION);
    mockResolveKeylessTarget.mockRejectedValue(new Error("malformed key"));

    await openDashboard(undefined, { print: true });

    expect(captured.out).toBe(CLAIM_DESTINATION.url);
  });

  test("subpath is refused instead of opening a dashboard page that doesn't exist yet", async () => {
    mockFindKeylessClaimUrl.mockResolvedValue(CLAIM_DESTINATION);

    await expect(openDashboard("users")).rejects.toThrow(/users.*hasn't been claimed/is);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("subpath refusal does not point at `clerk link`", async () => {
    mockFindKeylessClaimUrl.mockResolvedValue(CLAIM_DESTINATION);

    let message = "";
    try {
      await openDashboard("users");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toMatch(/clerk link/);
  });

  test("no claim link found, but a secret key is on disk: doesn't blindly say `clerk link`", async () => {
    mockFindKeylessClaimUrl.mockResolvedValue(undefined);
    mockResolveKeylessTarget.mockResolvedValue({ secretKey: "sk_test_x", source: ".env.local" });

    await expect(openDashboard(undefined)).rejects.toThrow(/clerk init --keyless/);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });

  test("no claim link and no secret key: falls back to the plain not-linked message", async () => {
    mockFindKeylessClaimUrl.mockResolvedValue(undefined);
    mockResolveKeylessTarget.mockResolvedValue(undefined);

    await expect(openDashboard(undefined)).rejects.toThrow(/clerk link.*clerk init/is);
    expect(mockOpenBrowser).not.toHaveBeenCalled();
  });
});
