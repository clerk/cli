import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  captureLog,
  configStubs,
  credentialStoreStubs,
  tokenExchangeStubs,
} from "../../test/lib/stubs.ts";
import { CliError } from "../../lib/errors.ts";

const mockGetValidToken = mock();
const mockFetchUserInfo = mock();
const mockResolveProfile = mock();
const mockIsAgent = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
}));

mock.module("../../lib/token-exchange.ts", () => ({
  ...tokenExchangeStubs,
  fetchUserInfo: (...args: unknown[]) => mockFetchUserInfo(...args),
}));

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => (mockIsAgent() ? "agent" : "human"),
}));

const { whoami } = await import("./index.ts");

const linkedProfile = {
  path: "github.com/clerk/cli",
  profile: {
    workspaceId: "ws_123",
    appId: "app_xxx",
    appName: "MyApp",
    instances: { development: "ins_dev_xxx", production: "ins_prod_xxx" },
  },
  resolvedVia: "remote" as const,
};

describe("whoami", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(() => {
    captured = captureLog();
    mockIsAgent.mockReturnValue(false);
    mockResolveProfile.mockResolvedValue(undefined);
  });

  afterEach(() => {
    captured.teardown();
    mockGetValidToken.mockReset();
    mockFetchUserInfo.mockReset();
    mockResolveProfile.mockReset();
    mockIsAgent.mockReset();
    consoleSpy?.mockRestore();
  });

  function runWhoami(options?: { json?: boolean }) {
    return captured.run(() => whoami(options));
  }

  test("prints email when authenticated", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({
      userId: "user_123",
      email: "alice@example.com",
    });

    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    await runWhoami();

    expect(captured.out).toContain("alice@example.com");
  });

  test("throws CliError when no token exists", async () => {
    mockGetValidToken.mockResolvedValue(null);

    await expect(runWhoami()).rejects.toThrow(CliError);
    await expect(captured.run(() => whoami())).rejects.toThrow(/Not logged in/);
    expect(captured.out).toBe("");
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("throws CliError when token is invalid", async () => {
    mockGetValidToken.mockResolvedValue("expired-token");
    mockFetchUserInfo.mockRejectedValue(new Error("Unauthorized"));

    await expect(runWhoami()).rejects.toThrow(CliError);
    await expect(captured.run(() => whoami())).rejects.toThrow(/Session expired/);
    expect(captured.out).toBe("");
  });

  test("prints linked app label on stderr when linked", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockResolvedValue(linkedProfile);

    await runWhoami();

    expect(captured.out.trim()).toBe("alice@example.com");
    expect(captured.err).toContain("Linked to");
    expect(captured.err).toContain("MyApp (app_xxx)");
  });

  test("falls back to appId when appName is missing", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockResolvedValue({
      ...linkedProfile,
      profile: { ...linkedProfile.profile, appName: undefined },
    });

    await runWhoami();

    expect(captured.err).toContain("Linked to");
    expect(captured.err).toContain("app_xxx");
    expect(captured.err).not.toContain("MyApp");
  });

  test("omits linked line when not linked", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockResolvedValue(undefined);

    await runWhoami();

    expect(captured.out.trim()).toBe("alice@example.com");
    expect(captured.err).not.toContain("Linked to");
  });

  test("omits linked line when resolveProfile throws (best-effort)", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockRejectedValue(new Error("git failed"));

    await runWhoami();

    expect(captured.out.trim()).toBe("alice@example.com");
    expect(captured.err).not.toContain("Linked to");
  });

  test("--json emits structured payload with linked details and suppresses next-steps", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockResolvedValue(linkedProfile);

    await runWhoami({ json: true });

    const payload = JSON.parse(captured.out);
    expect(payload).toEqual({
      email: "alice@example.com",
      linked: {
        appId: "app_xxx",
        appName: "MyApp",
        instances: { development: "ins_dev_xxx", production: "ins_prod_xxx" },
        resolvedVia: "remote",
        path: "github.com/clerk/cli",
      },
    });
    expect(captured.err).not.toContain("→");
    expect(captured.err).not.toContain("Linked to");
  });

  test("--json sets linked to null when not linked", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockResolvedValue(undefined);

    await runWhoami({ json: true });

    expect(JSON.parse(captured.out)).toEqual({
      email: "alice@example.com",
      linked: null,
    });
  });

  test("--json normalizes missing optional fields to null", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockResolvedValue({
      ...linkedProfile,
      profile: {
        ...linkedProfile.profile,
        appName: undefined,
        instances: { development: "ins_dev_xxx" },
      },
    });

    await runWhoami({ json: true });

    expect(JSON.parse(captured.out).linked).toMatchObject({
      appName: null,
      instances: { development: "ins_dev_xxx", production: null },
    });
  });

  test("agent mode emits JSON without --json flag", async () => {
    mockGetValidToken.mockResolvedValue("valid-token");
    mockFetchUserInfo.mockResolvedValue({ userId: "user_123", email: "alice@example.com" });
    mockResolveProfile.mockResolvedValue(linkedProfile);
    mockIsAgent.mockReturnValue(true);

    await runWhoami();

    const payload = JSON.parse(captured.out);
    expect(payload.email).toBe("alice@example.com");
    expect(payload.linked.appId).toBe("app_xxx");
    expect(captured.err).not.toContain("Linked to");
  });
});
