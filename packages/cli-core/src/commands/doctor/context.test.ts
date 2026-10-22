import { test, expect, describe, mock, spyOn, beforeEach, afterEach, afterAll } from "bun:test";
import {
  useCaptureLog,
  credentialStoreStubs,
  gitStubs,
  keylessTargetStubs,
  stubFetch,
} from "../../test/lib/stubs.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as config from "../../lib/config.ts";
import type { Application } from "../../lib/plapi.ts";
import { useCleanClerkKeyEnv } from "../../test/lib/clerk-key-env.ts";

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
let mockAppResponse: Application | Application[] | null = null;
let mockAppError: Error | null = null;
const mockFetch = mock();

// The link fix's `clerk link`: what it reports decides whether the fix applied.
const mockLink = mock();
mock.module("../link/index.ts", () => ({
  link: (...args: unknown[]) => mockLink(...args),
}));

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

  describe("verifyAccountAccess", () => {
    test("performs one memoized read-only application-list request, including for an empty list", async () => {
      mockAppResponse = [];

      const ctx = createDoctorContext();
      const p1 = ctx.verifyAccountAccess();
      const p2 = ctx.verifyAccountAccess();

      expect(p1).toBe(p2);
      await expect(p1).resolves.toBeUndefined();
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(String(mockFetch.mock.calls[0]?.[0])).toBe(
        "https://api.clerk.com/v1/platform/applications",
      );
      expect(mockFetch.mock.calls[0]?.[1]).toMatchObject({ method: "GET" });
    });

    test("memoizes a failed verification request", async () => {
      mockAppError = new TypeError("fetch failed");

      const ctx = createDoctorContext();
      const p1 = ctx.verifyAccountAccess();
      const p2 = ctx.verifyAccountAccess();

      expect(p1).toBe(p2);
      await expect(p1).rejects.toThrow("fetch failed");
      await expect(p2).rejects.toThrow("fetch failed");
      expect(mockFetch).toHaveBeenCalledTimes(1);
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
      delete process.env.CLERK_PLATFORM_API_KEY;
      mockGetToken.mockResolvedValue(null);

      const ctx = createDoctorContext();
      const result = await ctx.getApplication();

      expect(result).toBeNull();
      expect(mockFetch).not.toHaveBeenCalled();
    });

    test("fetches the public application shape with a Platform API key", async () => {
      mockGetToken.mockResolvedValue(null);
      mockResolveProfile.mockResolvedValue({
        path: "github.com/org/repo",
        profile: { workspaceId: "org_1", appId: "app_1", instances: { development: "ins_dev" } },
        resolvedVia: "remote" as const,
      });
      mockAppResponse = { application_id: "app_1", name: "My App", instances: [] };

      const ctx = createDoctorContext();
      expect(await ctx.getApplication()).toEqual(mockAppResponse);
      expect(mockFetch).toHaveBeenCalledTimes(1);
      expect(String(mockFetch.mock.calls[0]?.[0])).toContain("include_secret_keys=false");
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

  // The classifier decides from the folder's own reads, each once, and never
  // changes the folder: doctor leaves the project exactly as found.
  describe("getUnlinkedFolder", () => {
    useCleanClerkKeyEnv();
    const originalCwd = process.cwd;
    let dir: string;

    beforeEach(async () => {
      dir = await mkdtemp(join(tmpdir(), "clerk-doctor-folder-"));
      process.cwd = () => dir;
      delete process.env.CLERK_PLATFORM_API_KEY;
    });

    afterEach(async () => {
      process.cwd = originalCwd;
      await rm(dir, { recursive: true, force: true });
    });

    const write = (file: string, content: string) => Bun.write(join(dir, file), content);
    const PK = "pk_test_Zm9sZGVyLmNsZXJrLmFjY291bnRzLmRldiQ";

    test("returns the same promise, and reads the folder's keys once", async () => {
      await write(".env", `CLERK_PUBLISHABLE_KEY=${PK}\nCLERK_SECRET_KEY=sk_test_folder\n`);

      const ctx = createDoctorContext();
      const first = ctx.getUnlinkedFolder();

      expect(ctx.getUnlinkedFolder()).toBe(first);
      expect(ctx.getFolderKeys()).toBe(ctx.getFolderKeys());
      expect(await first).toMatchObject({
        kind: "unknown_owner",
        credential: "none",
        publishableKey: { name: "CLERK_PUBLISHABLE_KEY", source: ".env" },
      });
    });

    test("the API key wins, without reading the stored session", async () => {
      process.env.CLERK_PLATFORM_API_KEY = "test_key";
      mockGetToken.mockResolvedValue("stored_token");

      const folder = await createDoctorContext().getUnlinkedFolder();

      expect(folder.credential).toBe("api_key");
      expect(mockGetToken).not.toHaveBeenCalled();
    });

    test("a stored session counts as signed in", async () => {
      mockGetToken.mockResolvedValue("stored_token");

      expect((await createDoctorContext().getUnlinkedFolder()).credential).toBe("session");
    });

    test("an init token makes it an init app, and the token file stays", async () => {
      await write(
        ".clerk/keyless.json",
        JSON.stringify({ claimToken: "claim_token", createdAt: new Date().toISOString() }),
      );

      expect((await createDoctorContext().getUnlinkedFolder()).kind).toBe("init_app");
      expect(await Bun.file(join(dir, ".clerk", "keyless.json")).exists()).toBe(true);
    });

    // The claim-link check is part of the facts, so an SDK app whose claim link
    // can't be used never looks claimable.
    test("an SDK file whose claim URL isn't https: an SDK app with no usable claim link", async () => {
      await write(
        ".clerk/.tmp/keyless.json",
        JSON.stringify({
          publishableKey: PK,
          secretKey: "sk_test_sdk",
          claimUrl: "http://dashboard.clerk.com/apps/claim?token=x",
        }),
      );

      expect(await createDoctorContext().getUnlinkedFolder()).toMatchObject({
        kind: "sdk_app",
        unusable: { findableByKey: true },
      });
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

      // Exact: `doctor --fix` lists them, and agents may match on them.
      const loginFix = ctx.fixes.login();
      expect(loginFix.label).toBe("Log in with clerk auth login");
      expect(typeof loginFix.run).toBe("function");

      const linkFix = ctx.fixes.link();
      expect(linkFix.label).toBe("Link project with clerk link");
      expect(typeof linkFix.run).toBe("function");

      const envPullFix = ctx.fixes.envPull();
      expect(envPullFix.label).toBe("Pull env vars with clerk env pull");
      expect(typeof envPullFix.run).toBe("function");
    });

    test("the link fix applies when `clerk link` links the folder", async () => {
      mockLink.mockResolvedValue({ status: "linked", appId: "app_123" });

      await createDoctorContext().fixes.link().run();
    });

    // A person is claiming the SDK's app in the Dashboard; the folder isn't
    // linked yet, so the fix didn't apply.
    test("the link fix isn't applied when `clerk link` opened a claim page instead", async () => {
      mockLink.mockResolvedValue({ status: "claim_page_opened" });

      await expect(createDoctorContext().fixes.link().run()).rejects.toThrow(
        "claim the app on the page that opened, then run `clerk link` again",
      );
    });
  });
});
