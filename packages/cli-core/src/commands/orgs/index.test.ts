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

describe("clerk orgs", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-orgs-test-"));
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

  // --- orgs enable ---

  test("enable sends PATCH with organization_settings.enabled = true", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await captured.run(() => orgsEnable({}));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable passes --force-selection flag", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await captured.run(() => orgsEnable({ forceSelection: true }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.force_organization_selection).toBe(true);
  });

  test("enable passes --max-members flag", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await captured.run(() => orgsEnable({ maxMembers: "10" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.max_allowed_memberships).toBe(10);
  });

  test("enable passes --domains flag", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await captured.run(() => orgsEnable({ domains: true }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.domains_enabled).toBe(true);
  });

  test("enable passes --auto-create flag", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await captured.run(() => orgsEnable({ autoCreate: true }));

    const parsed = JSON.parse(capturedBody);
    expect(
      parsed.organization_settings.organization_creation_defaults.automatic_organization_creation
        .enabled,
    ).toBe(true);
  });

  test("enable shows success message", async () => {
    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await captured.run(() => orgsEnable({}));

    expect(captured.err).toContain("Organizations enabled");
  });

  test("enable errors when no profile is linked", async () => {
    const { orgsEnable } = await import("./index.ts");
    await expect(captured.run(() => orgsEnable({}))).rejects.toThrow("No Clerk project linked");
  });

  // --- orgs disable ---

  test("disable sends PATCH with organization_settings.enabled = false", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({ billing: { organization_enabled: false } }), {
        status: 200,
      });
    });

    await setupProfile();
    const { orgsDisable } = await import("./index.ts");
    await captured.run(() => orgsDisable({}));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.enabled).toBe(false);
  });

  test("disable warns when org billing is enabled", async () => {
    stubFetch(async (_input, init) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ billing: { organization_enabled: true } }), {
          status: 200,
        });
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsDisable } = await import("./index.ts");
    await captured.run(() => orgsDisable({}));

    expect(captured.err).toContain("Organization billing is enabled");
  });

  test("disable shows success message", async () => {
    stubFetch(async () => {
      return new Response(JSON.stringify({ billing: { organization_enabled: false } }), {
        status: 200,
      });
    });

    await setupProfile();
    const { orgsDisable } = await import("./index.ts");
    await captured.run(() => orgsDisable({}));

    expect(captured.err).toContain("Organizations disabled");
  });
});
