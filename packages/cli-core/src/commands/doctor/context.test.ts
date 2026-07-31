import { test, expect, describe, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import {
  useCaptureLog,
  credentialStoreStubs,
  gitStubs,
  keylessTargetStubs,
  stubFetch,
} from "../../test/lib/stubs.ts";
import * as config from "../../lib/config.ts";
import type { Application } from "../../lib/plapi.ts";

const mockGetToken = mock();

mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: (...args: unknown[]) => mockGetToken(...args),
}));

// spyOn (not mock.module) for config: a spy is restorable, so afterAll hands the
// real module back to doctor.test.ts when both run in one `bun test` process.
const mockResolveProfile = mock();
const resolveProfileSpy = spyOn(config, "resolveProfile").mockImplementation((...args: unknown[]) =>
  mockResolveProfile(...(args as [string])),
);
afterAll(() => resolveProfileSpy.mockRestore());

mock.module("../../lib/git.ts", () => gitStubs);

const mockResolveKeylessTarget = mock();
mock.module("../../lib/keyless-target.ts", () => ({
  ...keylessTargetStubs,
  resolveKeylessTarget: (...args: unknown[]) => mockResolveKeylessTarget(...args),
}));

const mockBapiRequest = mock();
mock.module("../../lib/bapi.ts", () => ({
  bapiRequest: (...args: unknown[]) => mockBapiRequest(...args),
}));

// stubFetch instead of mock.module for plapi — mock.module leaks globally in Bun
let mockAppResponse: Application | null = null;
let mockAppError: Error | null = null;
const mockFetch = mock();

const { createDoctorContext } = await import("./context.ts");

describe("createDoctorContext", () => {
  const originalFetch = globalThis.fetch;
  useCaptureLog();

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

    mockResolveKeylessTarget.mockReset();
    mockResolveKeylessTarget.mockResolvedValue(undefined);
    mockBapiRequest.mockReset();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockGetToken.mockReset();
    mockResolveProfile.mockReset();
    mockFetch.mockReset();
    mockResolveKeylessTarget.mockReset();
    mockBapiRequest.mockReset();
  });

  describe("getToken", () => {
    test("returns the same promise on repeated calls", async () => {
      mockGetToken.mockResolvedValue("test_token");

      const ctx = createDoctorContext();
      const p1 = ctx.getToken();
      const p2 = ctx.getToken();

      expect(p1).toBe(p2);
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

  describe("getKeylessTarget", () => {
    test("returns the same promise on repeated calls", async () => {
      const target = { secretKey: "sk_test_keyless", source: ".env.local" };
      mockResolveKeylessTarget.mockResolvedValue(target);

      const ctx = createDoctorContext();
      const p1 = ctx.getKeylessTarget();
      const p2 = ctx.getKeylessTarget();

      expect(p1).toBe(p2);
      expect(await p1).toEqual(target);
      expect(mockResolveKeylessTarget).toHaveBeenCalledTimes(1);
    });

    test("returns undefined when no keyless target resolves", async () => {
      mockResolveKeylessTarget.mockResolvedValue(undefined);

      const ctx = createDoctorContext();
      expect(await ctx.getKeylessTarget()).toBeUndefined();
    });
  });

  describe("getKeylessInstance", () => {
    test("returns null without hitting BAPI when there is no keyless target", async () => {
      mockResolveKeylessTarget.mockResolvedValue(undefined);

      const ctx = createDoctorContext();
      const result = await ctx.getKeylessInstance();

      expect(result).toBeNull();
      expect(mockBapiRequest).not.toHaveBeenCalled();
    });

    test("fetches instance info via the keyless secret key, only once", async () => {
      mockResolveKeylessTarget.mockResolvedValue({
        secretKey: "sk_test_keyless",
        source: ".env.local",
      });
      mockBapiRequest.mockResolvedValue({
        status: 200,
        body: { id: "ins_keyless_1", environment_type: "development" },
      });

      const ctx = createDoctorContext();
      const p1 = ctx.getKeylessInstance();
      const p2 = ctx.getKeylessInstance();

      expect(p1).toBe(p2);
      expect(await p1).toEqual({ id: "ins_keyless_1", environmentType: "development" });
      expect(mockBapiRequest).toHaveBeenCalledTimes(1);
      expect(mockBapiRequest).toHaveBeenCalledWith(
        expect.objectContaining({
          method: "GET",
          path: "/v1/instance",
          secretKey: "sk_test_keyless",
        }),
      );
    });

    test("returns null (not a throw) when the instance fetch fails", async () => {
      mockResolveKeylessTarget.mockResolvedValue({
        secretKey: "sk_test_keyless",
        source: ".env.local",
      });
      mockBapiRequest.mockRejectedValue(new Error("network down"));

      const ctx = createDoctorContext();
      expect(await ctx.getKeylessInstance()).toBeNull();
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
