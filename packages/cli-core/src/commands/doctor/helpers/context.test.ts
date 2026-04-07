import { test, expect, describe } from "bun:test";
import { testRoot } from "../../../test/lib/test-root.ts";
import { createDoctorContext } from "./context.ts";
import type { Application } from "../../../lib/plapi.ts";

const mockProfile = {
  path: "github.com/org/repo",
  profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
  resolvedVia: "remote" as const,
};

const mockApp: Application = { application_id: "app_1", name: "My App", instances: [] };

describe("createDoctorContext", () => {
  describe("getToken", () => {
    test("returns the same promise on repeated calls", async () => {
      const root = testRoot({
        credentialStore: { getToken: async () => "test_token" },
      });
      const ctx = createDoctorContext(root);
      const p1 = ctx.getToken();
      const p2 = ctx.getToken();

      expect(p1).toBe(p2);
      expect(await p1).toBe("test_token");
      expect(root.credentialStore.getToken).toHaveBeenCalledTimes(1);
    });
  });

  describe("getProfile", () => {
    test("returns the same promise on repeated calls", async () => {
      const root = testRoot({
        configStore: { resolveProfile: async () => mockProfile },
      });
      const ctx = createDoctorContext(root);
      const p1 = ctx.getProfile();
      const p2 = ctx.getProfile();

      expect(p1).toBe(p2);
      expect(await p1).toEqual(mockProfile);
      expect(root.configStore.resolveProfile).toHaveBeenCalledTimes(1);
    });
  });

  describe("getApplication", () => {
    test("calls fetchApplication only once", async () => {
      const root = testRoot({
        credentialStore: { getToken: async () => "test_token" },
        configStore: { resolveProfile: async () => mockProfile },
        plapi: { fetchApplication: async () => mockApp },
      });
      const ctx = createDoctorContext(root);
      const p1 = ctx.getApplication();
      const p2 = ctx.getApplication();

      expect(p1).toBe(p2);
      expect(await p1).toEqual(mockApp);
      expect(root.plapi.fetchApplication).toHaveBeenCalledTimes(1);
    });

    test("returns null when no token", async () => {
      let called = 0;
      const root = testRoot({
        credentialStore: { getToken: async () => null },
        plapi: {
          fetchApplication: async () => {
            called++;
            return mockApp;
          },
        },
      });
      const ctx = createDoctorContext(root);
      expect(await ctx.getApplication()).toBeNull();
      expect(called).toBe(0);
    });

    test("returns null when no profile", async () => {
      let called = 0;
      const root = testRoot({
        credentialStore: { getToken: async () => "test_token" },
        configStore: { resolveProfile: async () => undefined },
        plapi: {
          fetchApplication: async () => {
            called++;
            return mockApp;
          },
        },
      });
      const ctx = createDoctorContext(root);
      expect(await ctx.getApplication()).toBeNull();
      expect(called).toBe(0);
    });

    test("propagates errors from fetchApplication", async () => {
      const root = testRoot({
        credentialStore: { getToken: async () => "test_token" },
        configStore: { resolveProfile: async () => mockProfile },
        plapi: {
          fetchApplication: async () => {
            throw new Error("API failure");
          },
        },
      });
      const ctx = createDoctorContext(root);

      await expect(ctx.getApplication()).rejects.toThrow("API failure");
      await expect(ctx.getApplication()).rejects.toThrow("API failure");
      expect(root.plapi.fetchApplication).toHaveBeenCalledTimes(1);
    });
  });
});
