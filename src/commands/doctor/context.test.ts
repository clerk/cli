import { test, expect, describe, mock, beforeEach, afterEach } from "bun:test";
import { credentialStoreStubs, configStubs, gitStubs, stubFetch } from "../../test/stubs.ts";
import type { Application } from "../../lib/plapi.ts";

const mockGetToken = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

const mockResolveProfile = mock();

mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  resolveProfile: (...args: unknown[]) => mockResolveProfile(...args),
}));

mock.module("../../lib/git.ts", () => gitStubs);

// stubFetch instead of mock.module for plapi — mock.module leaks globally in Bun
let mockAppResponse: Application | null = null;
let mockAppError: Error | null = null;
const mockFetch = mock();

const { createDoctorContext } = await import("./context.ts");

describe("createDoctorContext", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    mockGetToken.mockReset();
    mockGetToken.mockResolvedValue(null);

    mockResolveProfile.mockReset();
    mockResolveProfile.mockResolvedValue(undefined);

    mockAppResponse = null;
    mockAppError = null;
    mockFetch.mockReset();
    mockFetch.mockImplementation(async () => {
      if (mockAppError) throw mockAppError;
      return new Response(JSON.stringify(mockAppResponse), { status: 200 });
    });
    stubFetch((...args: unknown[]) => mockFetch(...args));

    process.env.CLERK_PLATFORM_API_KEY = "test_key";
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockGetToken.mockReset();
    mockResolveProfile.mockReset();
    mockFetch.mockReset();
  });

  describe("getToken", () => {
    test("returns the same promise on repeated calls", async () => {
      mockGetToken.mockResolvedValue("test_token");

      const ctx = createDoctorContext();
      const p1 = ctx.getToken();
      const p2 = ctx.getToken();

      expect(p1).toBe(p2); // Same promise reference
      expect(await p1).toBe("test_token");
      expect(mockGetToken).toHaveBeenCalledTimes(1);
    });
  });

  describe("getProfile", () => {
    test("returns the same promise on repeated calls", async () => {
      const profile = {
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote" as const,
      };
      mockResolveProfile.mockResolvedValue(profile);

      const ctx = createDoctorContext();
      const p1 = ctx.getProfile();
      const p2 = ctx.getProfile();

      expect(p1).toBe(p2);
      expect(await p1).toEqual(profile);
      expect(mockResolveProfile).toHaveBeenCalledTimes(1);
    });
  });

  describe("getApplication", () => {
    test("calls fetchApplication only once", async () => {
      mockGetToken.mockResolvedValue("test_token");
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote" as const,
      });
      mockAppResponse = { application_id: "app_1", name: "My App", instances: [] };

      const ctx = createDoctorContext();
      const p1 = ctx.getApplication();
      const p2 = ctx.getApplication();

      expect(p1).toBe(p2);
      const result = await p1;
      expect(result).toEqual(mockAppResponse);
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    test("returns null when no token", async () => {
      mockGetToken.mockResolvedValue(null);

      const ctx = createDoctorContext();
      const result = await ctx.getApplication();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("returns null when no profile", async () => {
      mockGetToken.mockResolvedValue("test_token");
      mockResolveProfile.mockResolvedValue(undefined);

      const ctx = createDoctorContext();
      const result = await ctx.getApplication();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("propagates errors from fetchApplication", async () => {
      mockGetToken.mockResolvedValue("test_token");
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote" as const,
      });
      mockAppError = new Error("API failure");

      const ctx = createDoctorContext();

      await expect(ctx.getApplication()).rejects.toThrow("API failure");
      await expect(ctx.getApplication()).rejects.toThrow("API failure");
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("fixes", () => {
    test("fix factories return FixAction objects with labels", () => {
      const ctx = createDoctorContext();

      const loginFix = ctx.fixes.login();
      expect(loginFix.label).toContain("clerk auth login");
      expect(typeof loginFix.run).toBe("function");

      const linkFix = ctx.fixes.link();
      expect(linkFix.label).toContain("clerk link");
      expect(typeof linkFix.run).toBe("function");

      const envPullFix = ctx.fixes.envPull();
      expect(envPullFix.label).toContain("clerk env pull");
      expect(typeof envPullFix.run).toBe("function");
    });
  });
});
