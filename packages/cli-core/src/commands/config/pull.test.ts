import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import { credentialStoreStubs, gitStubs, stubFetch } from "../../test/stubs.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
mock.module("../../lib/spinner.ts", () => ({
  withSpinner: async (msg: string, fn: () => Promise<unknown>) => {
    console.error(msg);
    const result = await fn();
    return result;
  },
}));

describe("config pull", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  const mockConfig = {
    session: { lifetime: 604800 },
    sign_up: { mode: "public" },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-pull-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    stubFetch(async () => new Response(JSON.stringify(mockConfig), { status: 200 }));
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

  // Dynamically import to get fresh module state
  async function runConfigPull(
    options: { app?: string; instance?: string; output?: string; keys?: string[] } = {},
  ) {
    const { configPull } = await import("./pull.ts");
    return configPull(options);
  }

  test("errors when no profile is linked", async () => {
    await expect(runConfigPull()).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(runConfigPull()).rejects.toThrow("Not authenticated");
  });

  test("prints config JSON to stdout by default", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPull();
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(mockConfig, null, 2));
  });

  test("supports --app without a linked profile", async () => {
    const mockApp = {
      application_id: "app_1",
      instances: [{ instance_id: "ins_dev", environment_type: "development" }],
    };

    stubFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/instances/") && url.includes("/config")) {
        return new Response(JSON.stringify(mockConfig), { status: 200 });
      }
      if (url.includes("/v1/platform/applications/app_1")) {
        return new Response(JSON.stringify(mockApp), { status: 200 });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    await runConfigPull({ app: "app_1" });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(mockConfig, null, 2));
  });

  test("writes config to file with --output", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    const outFile = join(tempDir, "output.json");

    await runConfigPull({ output: outFile });
    const written = await Bun.file(outFile).json();
    expect(written).toEqual(mockConfig);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Config written to"));
  });

  test("shows which environment is being pulled", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pulling config from app_1 (development)"),
    );
  });

  test("shows app name when stored in profile", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      appName: "My SaaS App",
      instances: { development: "ins_dev" },
    });

    await runConfigPull();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pulling config from My SaaS App (development)"),
    );
  });

  test("shows production label when --instance prod", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigPull({ instance: "prod" });
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Pulling config from app_1 (production)"),
    );
  });

  test("uses development instance by default", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockConfig), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigPull();
    expect(requestedUrl).toContain("/instances/ins_dev/");
  });

  test("--instance prod targets production instance", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockConfig), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigPull({ instance: "prod" });
    expect(requestedUrl).toContain("/instances/ins_prod/");
  });

  test("--instance with literal ID passes through", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockConfig), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPull({ instance: "ins_custom_123" });
    expect(requestedUrl).toContain("/instances/ins_custom_123/");
  });

  test("errors when production instance not configured", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPull({ instance: "prod" })).rejects.toThrow(
      "No production instance configured",
    );
  });

  test("--keys passes keys as query params to the API", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify({ session: { lifetime: 604800 } }), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPull({ keys: ["session"] });
    expect(requestedUrl).toContain("keys=session");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ session: { lifetime: 604800 } }, null, 2));
  });

  test("--keys passes multiple keys as repeated query params", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(
        JSON.stringify({ session: { lifetime: 604800 }, sign_up: { mode: "public" } }),
        {
          status: 200,
        },
      );
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPull({ keys: ["session", "sign_up"] });
    expect(requestedUrl).toContain("keys=session");
    expect(requestedUrl).toContain("keys=sign_up");
  });

  test("handles API errors gracefully", async () => {
    stubFetch(async () => new Response("Unauthorized", { status: 401 }));

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPull()).rejects.toThrow("API error");
  });
});
