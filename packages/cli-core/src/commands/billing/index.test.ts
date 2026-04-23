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

describe("clerk billing", () => {
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

  // --- billing enable ---

  test("enable --for org sends organization_enabled = true", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: "org" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(true);
  });

  test("enable --for user sends user_enabled = true", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: "user" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.user_enabled).toBe(true);
  });

  test("enable errors without --for", async () => {
    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await expect(captured.run(() => billingEnable({}))).rejects.toThrow("--for is required");
  });

  test("enable errors with invalid --for value", async () => {
    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await expect(captured.run(() => billingEnable({ for: "invalid" }))).rejects.toThrow(
      'Must be "org" or "user"',
    );
  });

  test("enable shows success message", async () => {
    await setupProfile();
    const { billingEnable } = await import("./index.ts");
    await captured.run(() => billingEnable({ for: "org" }));

    expect(captured.err).toContain("Billing enabled for organizations");
  });

  // --- billing disable ---

  test("disable --for org sends organization_enabled = false", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { billingDisable } = await import("./index.ts");
    await captured.run(() => billingDisable({ for: "org" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.organization_enabled).toBe(false);
  });

  // --- plans create ---

  test("plans create sends correct plan config", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansCreate } = await import("./index.ts");
    await captured.run(() => plansCreate("pro", { amount: "1999", payer: "org" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans.pro.name).toBe("Pro");
    expect(parsed.billing.plans.pro.amount).toBe(1999);
    expect(parsed.billing.plans.pro.payer_type).toBe("org");
    expect(parsed.billing.plans.pro.is_recurring).toBe(true);
  });

  test("plans create auto-derives name from slug", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansCreate } = await import("./index.ts");
    await captured.run(() => plansCreate("enterprise-plus", { amount: "9999", payer: "org" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans["enterprise-plus"].name).toBe("Enterprise Plus");
  });

  test("plans create uses --name override", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansCreate } = await import("./index.ts");
    await captured.run(() =>
      plansCreate("pro", { amount: "1999", payer: "org", name: "Pro Plus" }),
    );

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans.pro.name).toBe("Pro Plus");
  });

  test("plans create with --trial-days enables trial", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansCreate } = await import("./index.ts");
    await captured.run(() => plansCreate("pro", { amount: "1999", payer: "org", trialDays: "14" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans.pro.free_trial_enabled).toBe(true);
    expect(parsed.billing.plans.pro.free_trial_days).toBe(14);
  });

  test("plans create with --hidden sets publicly_visible = false", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansCreate } = await import("./index.ts");
    await captured.run(() => plansCreate("pro", { amount: "1999", payer: "org", hidden: true }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans.pro.publicly_visible).toBe(false);
  });

  test("plans create shows success message", async () => {
    await setupProfile();
    const { plansCreate } = await import("./index.ts");
    await captured.run(() => plansCreate("pro", { amount: "1999", payer: "org" }));

    expect(captured.err).toContain("created");
  });

  // --- plans list ---

  test("plans list outputs plans", async () => {
    stubFetch(async () => {
      return new Response(
        JSON.stringify({
          billing: {
            plans: {
              free_org: { name: "Free", amount: 0, payer_type: "org", publicly_visible: true },
              pro: {
                name: "Pro",
                amount: 1999,
                currency: "usd",
                payer_type: "org",
                publicly_visible: true,
              },
            },
          },
        }),
        { status: 200 },
      );
    });

    await setupProfile();
    const { plansList } = await import("./index.ts");
    await captured.run(() => plansList({}));

    expect(captured.err).toContain("Free");
    expect(captured.err).toContain("Pro");
  });

  test("plans list --json outputs JSON", async () => {
    const plansData = {
      free_org: { name: "Free", amount: 0, payer_type: "org" },
    };
    stubFetch(async () => {
      return new Response(JSON.stringify({ billing: { plans: plansData } }), { status: 200 });
    });

    await setupProfile();
    const { plansList } = await import("./index.ts");
    await captured.run(() => plansList({ json: true }));

    expect(captured.out).toContain('"Free"');
  });

  test("plans list shows message when no plans", async () => {
    stubFetch(async () => {
      return new Response(JSON.stringify({ billing: { plans: {} } }), { status: 200 });
    });

    await setupProfile();
    const { plansList } = await import("./index.ts");
    await captured.run(() => plansList({}));

    expect(captured.err).toContain("No plans configured");
  });

  // --- plans update ---

  test("plans update sends partial plan config", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansUpdate } = await import("./index.ts");
    await captured.run(() => plansUpdate("pro", { amount: "2999" }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans.pro.amount).toBe(2999);
  });

  test("plans update --hidden sets publicly_visible = false", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansUpdate } = await import("./index.ts");
    await captured.run(() => plansUpdate("pro", { hidden: true }));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans.pro.publicly_visible).toBe(false);
  });

  test("plans update errors with no options", async () => {
    await setupProfile();
    const { plansUpdate } = await import("./index.ts");
    await expect(captured.run(() => plansUpdate("pro", {}))).rejects.toThrow(
      "No update options provided",
    );
  });

  // --- plans remove ---

  test("plans remove sends config without the plan", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (!init?.method || init.method === "GET") {
        return new Response(
          JSON.stringify({
            billing: {
              plans: {
                free_org: { name: "Free", amount: 0 },
                pro: { name: "Pro", amount: 1999 },
              },
            },
          }),
          { status: 200 },
        );
      }
      if (init?.method === "PATCH") capturedBody = init.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansRemove } = await import("./index.ts");
    await captured.run(() => plansRemove("pro", {}));

    const parsed = JSON.parse(capturedBody);
    expect(parsed.billing.plans).not.toHaveProperty("pro");
    expect(parsed.billing.plans).toHaveProperty("free_org");
  });

  test("plans remove sends ?destructive=true", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (!init?.method || init.method === "GET") {
        return new Response(JSON.stringify({ billing: { plans: { pro: { name: "Pro" } } } }), {
          status: 200,
        });
      }
      if (init?.method === "PATCH") capturedUrl = input.toString();
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await setupProfile();
    const { plansRemove } = await import("./index.ts");
    await captured.run(() => plansRemove("pro", {}));

    expect(capturedUrl).toContain("destructive=true");
  });

  test("plans remove errors when plan not found", async () => {
    stubFetch(async () => {
      return new Response(JSON.stringify({ billing: { plans: {} } }), { status: 200 });
    });

    await setupProfile();
    const { plansRemove } = await import("./index.ts");
    await expect(captured.run(() => plansRemove("nonexistent", {}))).rejects.toThrow(
      'Plan "nonexistent" not found',
    );
  });
});
