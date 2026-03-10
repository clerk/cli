import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config";
import { credentialStoreStubs, gitStubs, stubFetch } from "../../test/stubs.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);

describe("config schema", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  const mockSchema = {
    type: "object",
    properties: {
      session: {
        type: "object",
        properties: { lifetime: { type: "integer" } },
      },
    },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-schema-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    stubFetch(async () => new Response(JSON.stringify(mockSchema), { status: 200 }));
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function runConfigSchema(
    options: { instance?: string; output?: string; keys?: string[] } = {},
  ) {
    const { configSchema } = await import("./schema");
    return configSchema(options);
  }

  test("errors when no profile is linked", async () => {
    await expect(runConfigSchema()).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(runConfigSchema()).rejects.toThrow("Not authenticated");
  });

  test("prints schema JSON to stdout by default", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigSchema();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(mockSchema, null, 2));
  });

  test("writes schema to file with --output", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    const outFile = join(tempDir, "schema.json");

    await runConfigSchema({ output: outFile });
    const written = await Bun.file(outFile).json();
    expect(written).toEqual(mockSchema);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Schema written to"));
  });

  test("shows which environment is being pulled", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigSchema();
    expect(errorSpy).toHaveBeenCalledWith("Pulling config schema from development instance...");
  });

  test("shows production label when --instance prod", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigSchema({ instance: "prod" });
    expect(errorSpy).toHaveBeenCalledWith("Pulling config schema from production instance...");
  });

  test("uses development instance by default", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockSchema), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigSchema();
    expect(requestedUrl).toContain("/instances/ins_dev/");
  });

  test("--instance prod targets production instance", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockSchema), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigSchema({ instance: "prod" });
    expect(requestedUrl).toContain("/instances/ins_prod/");
  });

  test("--instance with literal ID passes through", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockSchema), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigSchema({ instance: "ins_custom_123" });
    expect(requestedUrl).toContain("/instances/ins_custom_123/");
  });

  test("passes --keys to API as query params", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockSchema), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigSchema({ keys: ["session", "sign_up"] });
    expect(requestedUrl).toContain("keys=session");
    expect(requestedUrl).toContain("keys=sign_up");
    expect(requestedUrl).toContain("/config/schema");
  });

  test("errors when production instance not configured", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigSchema({ instance: "prod" })).rejects.toThrow(
      "No production instance configured",
    );
  });

  test("handles API errors gracefully", async () => {
    stubFetch(async () => new Response("Unauthorized", { status: 401 }));

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigSchema()).rejects.toThrow("API error");
  });
});
