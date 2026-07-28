import { test, expect, describe, beforeEach, afterEach, mock, spyOn } from "bun:test";
import {
  configStubs,
  credentialStoreStubs,
  tokenExchangeStubs,
  useCaptureLog,
} from "../../test/lib/stubs.ts";
import { CliError } from "../../lib/errors.ts";

const mockGetValidToken = mock();
const mockHasStoredCredentials = mock();
const mockFetchUserInfo = mock();
const mockResolveProfile = mock();
const mockIsAgent = mock();
const mockResolveKeylessTarget = mock();
const mockFindLocalPublishableKey = mock();
const mockHasKeyPairMismatch = mock();
const mockBapiRequest = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getValidToken: (...args: unknown[]) => mockGetValidToken(...args),
  hasStoredCredentials: (...args: unknown[]) => mockHasStoredCredentials(...args),
}));

mock.module("../../lib/keyless-target.ts", () => ({
  resolveKeylessTarget: (...args: unknown[]) => mockResolveKeylessTarget(...args),
  findLocalPublishableKey: (...args: unknown[]) => mockFindLocalPublishableKey(...args),
  hasKeyPairMismatch: (...args: unknown[]) => mockHasKeyPairMismatch(...args),
}));

mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
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
  const captured = useCaptureLog();

  beforeEach(() => {
    mockIsAgent.mockReturnValue(false);
    mockResolveProfile.mockResolvedValue(undefined);
    mockHasStoredCredentials.mockResolvedValue(false);
    mockResolveKeylessTarget.mockResolvedValue(undefined);
    mockFindLocalPublishableKey.mockResolvedValue(undefined);
    mockHasKeyPairMismatch.mockResolvedValue(false);
  });

  afterEach(() => {
    mockGetValidToken.mockReset();
    mockHasStoredCredentials.mockReset();
    mockFetchUserInfo.mockReset();
    mockResolveProfile.mockReset();
    mockIsAgent.mockReset();
    mockResolveKeylessTarget.mockReset();
    mockFindLocalPublishableKey.mockReset();
    mockHasKeyPairMismatch.mockReset();
    mockBapiRequest.mockReset();
    consoleSpy?.mockRestore();
  });

  function runWhoami(options?: { json?: boolean }) {
    return whoami(options);
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
    await expect(whoami()).rejects.toThrow(/Not logged in/);
    expect(captured.out).toBe("");
    expect(mockFetchUserInfo).not.toHaveBeenCalled();
  });

  test("throws CliError when token is invalid", async () => {
    mockGetValidToken.mockResolvedValue("expired-token");
    mockFetchUserInfo.mockRejectedValue(new Error("Unauthorized"));

    await expect(runWhoami()).rejects.toThrow(CliError);
    await expect(whoami()).rejects.toThrow(/Session expired/);
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

  describe("keyless", () => {
    const KEYLESS_TARGET = { secretKey: "sk_test_keyless", source: ".env.local" };

    /** Points the keyless fallback at an instance the Backend API will answer for. */
    function withKeylessProject(): void {
      mockResolveKeylessTarget.mockResolvedValue(KEYLESS_TARGET);
      mockFindLocalPublishableKey.mockResolvedValue("pk_test_keyless");
      mockBapiRequest.mockResolvedValue({
        body: { id: "ins_keyless_1", environment_type: "development" },
      });
    }

    test("reports the keyless instance when there is no account at all", async () => {
      mockGetValidToken.mockResolvedValue(null);
      withKeylessProject();

      await runWhoami({ json: true });

      expect(JSON.parse(captured.out)).toEqual({
        email: null,
        linked: null,
        keyless: {
          instanceId: "ins_keyless_1",
          environmentType: "development",
          publishableKey: "pk_test_keyless",
          publishableKeyMismatch: false,
          keySource: ".env.local",
        },
      });
    });

    test("warns and flags the JSON payload when the local publishable key belongs to a different app", async () => {
      mockGetValidToken.mockResolvedValue(null);
      withKeylessProject();
      mockHasKeyPairMismatch.mockResolvedValue(true);

      await runWhoami({ json: true });

      expect(JSON.parse(captured.out)).toMatchObject({
        keyless: { publishableKeyMismatch: true },
      });
      expect(captured.err).toContain("doesn't belong to this secret key's application");
    });

    test("a failed pairing check doesn't block reporting the identity", async () => {
      mockGetValidToken.mockResolvedValue(null);
      withKeylessProject();
      mockHasKeyPairMismatch.mockRejectedValue(new Error("network blip"));

      await runWhoami({ json: true });

      expect(JSON.parse(captured.out)).toMatchObject({
        keyless: { instanceId: "ins_keyless_1", publishableKeyMismatch: false },
      });
    });

    test("no pairing check runs when no local publishable key is found", async () => {
      mockGetValidToken.mockResolvedValue(null);
      withKeylessProject();
      mockFindLocalPublishableKey.mockResolvedValue(undefined);

      await runWhoami({ json: true });

      expect(mockHasKeyPairMismatch).not.toHaveBeenCalled();
      expect(JSON.parse(captured.out)).toMatchObject({
        keyless: { publishableKey: null, publishableKeyMismatch: false },
      });
    });

    test("wraps an invalid keyless secret key with context naming the key and its source", async () => {
      mockGetValidToken.mockResolvedValue(null);
      mockResolveKeylessTarget.mockResolvedValue(KEYLESS_TARGET);
      const { BapiError } = await import("../../lib/errors.ts");
      mockBapiRequest.mockRejectedValue(
        new BapiError(401, '{"errors":[{"message":"invalid key"}]}', new Headers()),
      );

      const error = await runWhoami({ json: true }).catch((e: unknown) => e);

      expect((error as { context?: string }).context).toContain(".env.local");
    });

    // A login whose refresh token the server has since rejected used to abort
    // whoami outright, because the "am I signed in?" question threw instead of
    // answering no.
    test("falls back to keyless when the stored session can no longer be refreshed", async () => {
      mockGetValidToken.mockRejectedValue(new CliError("Token refresh failed (401)"));
      mockHasStoredCredentials.mockResolvedValue(true);
      withKeylessProject();

      await runWhoami({ json: true });

      expect(JSON.parse(captured.out)).toMatchObject({
        email: null,
        keyless: { instanceId: "ins_keyless_1" },
      });
      expect(mockFetchUserInfo).not.toHaveBeenCalled();
    });

    test("an unrefreshable session with no keyless keys still reports an expired session", async () => {
      mockGetValidToken.mockRejectedValue(new CliError("Token refresh failed (401)"));
      mockHasStoredCredentials.mockResolvedValue(true);

      await expect(runWhoami()).rejects.toThrow(/Session expired/);
    });

    test("no credentials and no keyless keys reports not logged in", async () => {
      mockGetValidToken.mockResolvedValue(null);

      await expect(runWhoami()).rejects.toThrow(/Not logged in/);
    });

    test("human output names the instance and where its key came from", async () => {
      mockGetValidToken.mockResolvedValue(null);
      withKeylessProject();

      await runWhoami();

      expect(captured.out.trim()).toBe("ins_keyless_1");
      expect(captured.err).toContain("unclaimed keyless application");
      expect(captured.err).toContain(".env.local");
    });
  });
});
