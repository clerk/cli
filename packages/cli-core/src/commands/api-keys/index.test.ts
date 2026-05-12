import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import {
  captureLog,
  credentialStoreStubs,
  gitStubs,
  promptsStubs,
  stubFetch,
} from "../../test/lib/stubs.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
mock.module("@inquirer/prompts", () => promptsStubs);
mock.module("../../lib/spinner.ts", () => ({
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

describe("clerk enable/disable api-keys", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-api-keys-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();

    stubFetch(async () => {
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  afterEach(async () => {
    captured.teardown();
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function setupProfile() {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
  }

  test("enable defaults to user API Keys", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { apiKeysEnable } = await import("./index.ts");
    await captured.run(() => apiKeysEnable({}));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.api_keys_settings.enabled).toBe(true);
    expect(parsed.api_keys_settings.user_api_keys_enabled).toBe(true);
    expect(parsed.api_keys_settings.orgs_api_keys_enabled).toBeUndefined();
    expect(parsed.organization_settings).toBeUndefined();
  });

  test("enable --for orgs enables org API Keys and cascades organizations", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { apiKeysEnable } = await import("./index.ts");
    await captured.run(() => apiKeysEnable({ for: ["orgs"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.api_keys_settings.enabled).toBe(true);
    expect(parsed.api_keys_settings.orgs_api_keys_enabled).toBe(true);
    expect(parsed.api_keys_settings.user_api_keys_enabled).toBeUndefined();
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable --for users,orgs sets both API Keys targets", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { apiKeysEnable } = await import("./index.ts");
    await captured.run(() => apiKeysEnable({ for: ["users,orgs"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.api_keys_settings.user_api_keys_enabled).toBe(true);
    expect(parsed.api_keys_settings.orgs_api_keys_enabled).toBe(true);
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable rejects invalid --for token", async () => {
    await setupProfile();
    const { apiKeysEnable } = await import("./index.ts");
    await expect(captured.run(() => apiKeysEnable({ for: ["machine"] }))).rejects.toThrow(
      'Invalid --for value: "machine". Expected "orgs" and/or "users".',
    );
  });

  test("enable accepts singular --for aliases", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { apiKeysEnable } = await import("./index.ts");
    await captured.run(() => apiKeysEnable({ for: ["user", "org"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.api_keys_settings.user_api_keys_enabled).toBe(true);
    expect(parsed.api_keys_settings.orgs_api_keys_enabled).toBe(true);
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable --dry-run plumbs dry_run=true to the API", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method === "PATCH") capturedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { apiKeysEnable } = await import("./index.ts");
    await captured.run(() => apiKeysEnable({ dryRun: true }));

    expect(capturedUrl).toContain("dry_run=true");
    expect(captured.err).toContain("[dry-run]");
  });

  test("disable with no --for disables API Keys entirely", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(
        JSON.stringify({
          api_keys_settings: {
            enabled: true,
            user_api_keys_enabled: true,
            orgs_api_keys_enabled: true,
          },
        }),
        { status: 200 },
      );
    });

    await setupProfile();
    const { apiKeysDisable } = await import("./index.ts");
    await captured.run(() => apiKeysDisable({}));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.api_keys_settings.enabled).toBe(false);
    expect(parsed.api_keys_settings.user_api_keys_enabled).toBe(false);
    expect(parsed.api_keys_settings.orgs_api_keys_enabled).toBe(false);
  });

  test("disable --for orgs only disables org API Keys", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(
        JSON.stringify({
          api_keys_settings: {
            enabled: true,
            user_api_keys_enabled: true,
            orgs_api_keys_enabled: true,
          },
        }),
        { status: 200 },
      );
    });

    await setupProfile();
    const { apiKeysDisable } = await import("./index.ts");
    await captured.run(() => apiKeysDisable({ for: ["orgs"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.api_keys_settings.enabled).toBeUndefined();
    expect(parsed.api_keys_settings.user_api_keys_enabled).toBeUndefined();
    expect(parsed.api_keys_settings.orgs_api_keys_enabled).toBe(false);
  });

  test("disable shows no changes when already fully disabled", async () => {
    let patchCalls = 0;
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") patchCalls++;
      return new Response(
        JSON.stringify({
          api_keys_settings: {
            enabled: false,
            user_api_keys_enabled: false,
            orgs_api_keys_enabled: false,
          },
        }),
        { status: 200 },
      );
    });

    await setupProfile();
    const { apiKeysDisable } = await import("./index.ts");
    await captured.run(() => apiKeysDisable({}));

    expect(patchCalls).toBe(0);
    expect(captured.err).toContain("No changes detected");
  });
});
