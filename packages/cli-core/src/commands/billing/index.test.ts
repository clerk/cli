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

describe("clerk enable/disable billing", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-billing-test-"));
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

  // --- enable ---

  test("enable --for org sends organization_enabled = true and cascades organization_settings.enabled", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: ["org"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(true);
    expect(parsed.billing.user_enabled).toBeUndefined();
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable --for user sends user_enabled = true and does NOT cascade orgs", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: ["user"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.user_enabled).toBe(true);
    expect(parsed.billing.organization_enabled).toBeUndefined();
    expect(parsed.organization_settings).toBeUndefined();
  });

  test("enable --for org,user (CSV form) sets both billing fields and cascades orgs", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: ["org,user"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(true);
    expect(parsed.billing.user_enabled).toBe(true);
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable --for org user (variadic form) sets both billing fields and cascades orgs", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    // Commander variadic produces a string[] when the user writes
    // `--for org user` or `--for org --for user`.
    await captured.run(() => billingEnable({ for: ["org", "user"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(true);
    expect(parsed.billing.user_enabled).toBe(true);
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable with no --for defaults to both targets and cascades orgs", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({}));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(true);
    expect(parsed.billing.user_enabled).toBe(true);
    expect(parsed.organization_settings.enabled).toBe(true);
  });

  test("enable rejects invalid --for token", async () => {
    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await expect(captured.run(() => billingEnable({ for: ["foo"] }))).rejects.toThrow(
      'Invalid --for value: "foo"',
    );
  });

  test("enable rejects empty --for value", async () => {
    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await expect(captured.run(() => billingEnable({ for: [","] }))).rejects.toThrow(
      "--for must include at least one of",
    );
  });

  test("enable trims whitespace and dedupes --for tokens", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: [" org , org , user "] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(true);
    expect(parsed.billing.user_enabled).toBe(true);
  });

  test("enable shows success message", async () => {
    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: ["org"] }));

    expect(captured.err).toContain("Billing enabled for organizations");
  });

  test("enable --dry-run plumbs dry_run=true to the API", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method === "PATCH") capturedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: ["org"], dryRun: true }));

    expect(capturedUrl).toContain("dry_run=true");
    expect(captured.err).toContain("[dry-run]");
  });

  // --- disable ---

  test("disable --for org sets organization_enabled = false and never touches organization_settings", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingDisable } = await import("./index.ts");
    await captured.run(() => billingDisable({ for: ["org"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(false);
    expect(parsed.billing.user_enabled).toBeUndefined();
    expect(parsed.organization_settings).toBeUndefined();
  });

  test("disable --for user sets user_enabled = false and never touches organization_settings", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingDisable } = await import("./index.ts");
    await captured.run(() => billingDisable({ for: ["user"] }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.user_enabled).toBe(false);
    expect(parsed.billing.organization_enabled).toBeUndefined();
    expect(parsed.organization_settings).toBeUndefined();
  });

  test("disable with no --for defaults to both targets and never cascades to orgs", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(
        JSON.stringify({
          billing: { organization_enabled: true, user_enabled: true },
          organization_settings: { enabled: true },
        }),
        { status: 200 },
      );
    });

    await setupProfile();
    const { billingDisable } = await import("./index.ts");
    await captured.run(() => billingDisable({}));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(false);
    expect(parsed.billing.user_enabled).toBe(false);
    expect(parsed.organization_settings).toBeUndefined();
  });

  test("disable shows success message", async () => {
    await setupProfile();
    const { billingDisable } = await import("./index.ts");
    await captured.run(() => billingDisable({ for: ["org"] }));

    expect(captured.err).toContain("Billing disabled for organizations");
  });

  test("disable --dry-run plumbs dry_run=true", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method === "PATCH") capturedUrl = input.toString();
      return new Response(
        JSON.stringify({ billing: { organization_enabled: true, user_enabled: true } }),
        { status: 200 },
      );
    });

    await setupProfile();
    const { billingDisable } = await import("./index.ts");
    await captured.run(() => billingDisable({ dryRun: true }));

    expect(capturedUrl).toContain("dry_run=true");
    expect(captured.err).toContain("[dry-run]");
  });
});
