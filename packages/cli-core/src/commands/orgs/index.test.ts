import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import { useCaptureLog, credentialStoreStubs, gitStubs, stubFetch } from "../../test/lib/stubs.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
mock.module("../../lib/spinner.ts", () => ({
  intro: () => {},
  outro: () => {},
  pausedOutro: () => {},
  bar: () => {},
  withGutter: async (
    _title: string,
    fn: (controls: { setNextSteps: (steps: readonly string[]) => void }) => Promise<unknown>,
  ) => fn({ setNextSteps: () => {} }),
  withSpinner: async (_msg: string, fn: () => Promise<unknown>) => fn(),
}));

describe("clerk enable/disable orgs", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-orgs-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    stubFetch(async () => {
      return new Response(JSON.stringify({}), { status: 200 });
    });
  });

  afterEach(async () => {
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

  // --- enable ---

  test("enable sends PATCH with organization_settings.enabled = true", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await orgsEnable({});

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
    await orgsEnable({ forceSelection: true });

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.force_organization_selection).toBe(true);
  });

  test("enable passes --max-members flag as integer", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await orgsEnable({ maxMembers: "10" });

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.max_allowed_memberships).toBe(10);
  });

  test("enable rejects non-numeric --max-members before any API call", async () => {
    let calls = 0;
    stubFetch(async () => {
      calls++;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await expect(orgsEnable({ maxMembers: "abc" })).rejects.toThrow(
      "--max-members must be a positive integer",
    );
    expect(calls).toBe(0);
  });

  test("enable rejects partial-numeric --max-members like '12abc'", async () => {
    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await expect(orgsEnable({ maxMembers: "12abc" })).rejects.toThrow(
      "--max-members must be a positive integer",
    );
  });

  test("enable rejects --max-members = 0", async () => {
    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await expect(orgsEnable({ maxMembers: "0" })).rejects.toThrow(
      "--max-members must be a positive integer",
    );
  });

  test("enable passes --domains flag", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await orgsEnable({ domains: true });

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
    await orgsEnable({ autoCreate: true });

    const parsed = JSON.parse(capturedBody);
    expect(
      parsed.organization_settings.organization_creation_defaults.automatic_organization_creation
        .enabled,
    ).toBe(true);
  });

  test("enable --dry-run plumbs dry_run=true to the API and prints dry-run output", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method === "PATCH") capturedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await orgsEnable({ dryRun: true });

    expect(capturedUrl).toContain("dry_run=true");
    expect(captured.err).toContain("[dry-run]");
  });

  test("enable shows success message", async () => {
    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await orgsEnable({});

    expect(captured.err).toContain("Organizations enabled");
  });

  test("enable reports no changes when already enabled", async () => {
    let patchCalls = 0;
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") patchCalls++;
      // Current config already has orgs enabled with no extra flags.
      return new Response(JSON.stringify({ organization_settings: { enabled: true } }), {
        status: 200,
      });
    });

    await setupProfile();
    const { orgsEnable } = await import("./index.ts");
    await orgsEnable({});

    expect(patchCalls).toBe(0);
    expect(captured.err).toContain("No changes detected");
  });

  test("enable errors when no profile is linked", async () => {
    const { orgsEnable } = await import("./index.ts");
    await expect(orgsEnable({})).rejects.toThrow("No Clerk project linked");
  });

  // --- disable ---

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
    await orgsDisable({});

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.enabled).toBe(false);
  });

  test("disable in agent mode refuses when org billing is enabled and no --yes is set", async () => {
    let patchCalls = 0;
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") patchCalls++;
      return new Response(JSON.stringify({ billing: { organization_enabled: true } }), {
        status: 200,
      });
    });

    await setupProfile();
    const { orgsDisable } = await import("./index.ts");
    await expect(orgsDisable({})).rejects.toThrow("Organization billing is enabled");
    expect(patchCalls).toBe(0);
  });

  test("disable with --yes still prints the stranded-billing warning before patching", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({ billing: { organization_enabled: true } }), {
        status: 200,
      });
    });

    await setupProfile();
    const { orgsDisable } = await import("./index.ts");
    await orgsDisable({ yes: true });

    expect(captured.err).toContain("Organization billing is currently enabled");
    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.enabled).toBe(false);
  });

  test("disable in agent mode proceeds with --yes even when org billing is enabled", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({ billing: { organization_enabled: true } }), {
        status: 200,
      });
    });

    await setupProfile();
    const { orgsDisable } = await import("./index.ts");
    await orgsDisable({ yes: true });

    const parsed = JSON.parse(capturedBody);
    expect(parsed.organization_settings.enabled).toBe(false);
  });

  test("disable shows success message when billing is off", async () => {
    stubFetch(async () => {
      return new Response(JSON.stringify({ billing: { organization_enabled: false } }), {
        status: 200,
      });
    });

    await setupProfile();
    const { orgsDisable } = await import("./index.ts");
    await orgsDisable({});

    expect(captured.err).toContain("Organizations disabled");
  });
});
