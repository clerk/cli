import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config";
import { stubFetch } from "../../test/stubs.ts";

describe("config push", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  const mockResponse = {
    session: { lifetime: 3600 },
    sign_up: { mode: "public" },
  };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-config-push-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_PLATFORM_API_KEY = "test_key";
    process.env.CLERK_PLATFORM_API_URL = "https://test-api.clerk.com";

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    stubFetch(async () => new Response(JSON.stringify(mockResponse), { status: 200 }));
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

  async function runConfigPatch(
    options: {
      instance?: string;
      file?: string;
      json?: string;
      dryRun?: boolean;
      yes?: boolean;
    } = {},
  ) {
    const { configPatch } = await import("./push");
    return configPatch(options);
  }

  async function runConfigPut(
    options: {
      instance?: string;
      file?: string;
      json?: string;
      dryRun?: boolean;
      yes?: boolean;
    } = {},
  ) {
    const { configPut } = await import("./push");
    return configPut(options);
  }

  // --- Shared error cases ---

  test("errors when no profile is linked", async () => {
    await expect(runConfigPatch({ json: '{"a":1}' })).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No Clerk project linked"));
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(runConfigPatch({ json: '{"a":1}', yes: true })).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("CLERK_PLATFORM_API_KEY"));
  });

  test("errors when no input source is provided", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    // Without --file or --json, falls through to stdin which yields empty input
    await expect(runConfigPatch()).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("No input"));
  });

  test("errors on invalid JSON input", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ json: "not-json" })).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Invalid JSON"));
  });

  test("errors when JSON is an array", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ json: "[1,2,3]" })).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Config must be a JSON object"));
  });

  test("errors when --file points to nonexistent file", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ file: "/tmp/does-not-exist.json" })).rejects.toThrow(
      "process.exit",
    );
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("File not found"));
  });

  // --- PATCH happy paths ---

  test("patch sends PATCH method with --json input", async () => {
    let capturedMethod = "";
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      capturedMethod = init?.method ?? "GET";
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"session":{"lifetime":3600}}', yes: true });
    expect(capturedMethod).toBe("PATCH");
    expect(JSON.parse(capturedBody)).toEqual({ session: { lifetime: 3600 } });
  });

  test("patch reads config from --file", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    const configFile = join(tempDir, "input.json");
    await Bun.write(configFile, JSON.stringify({ session: { lifetime: 7200 } }));

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ file: configFile, yes: true });
    expect(JSON.parse(capturedBody)).toEqual({ session: { lifetime: 7200 } });
  });

  test("patch prints returned config to stdout", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"session":{"lifetime":3600}}', yes: true });
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(mockResponse, null, 2));
  });

  test("patch shows 'Updating' label", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"session":{"lifetime":3600}}', yes: true });
    expect(errorSpy).toHaveBeenCalledWith("Updating config on development instance...");
  });

  // --- PUT happy paths ---

  test("put sends PUT method", async () => {
    let capturedMethod = "";
    stubFetch(async (_input, init) => {
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({ json: '{"session":{"lifetime":3600}}', yes: true });
    expect(capturedMethod).toBe("PUT");
  });

  test("put shows 'Replacing' label", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({ json: '{"session":{"lifetime":3600}}', yes: true });
    expect(errorSpy).toHaveBeenCalledWith("Replacing config on development instance...");
  });

  // --- Instance targeting ---

  test("targets development instance by default", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigPatch({ json: '{"a":1}', yes: true });
    expect(requestedUrl).toContain("/instances/ins_dev/");
  });

  test("--instance prod targets production instance", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev", production: "ins_prod" },
    });

    await runConfigPatch({ json: '{"a":1}', instance: "prod", yes: true });
    expect(requestedUrl).toContain("/instances/ins_prod/");
  });

  test("--instance with literal ID passes through", async () => {
    let requestedUrl = "";
    stubFetch(async (input) => {
      requestedUrl = input.toString();
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({ json: '{"a":1}', instance: "ins_custom_123", yes: true });
    expect(requestedUrl).toContain("/instances/ins_custom_123/");
  });

  // --- Dry run ---

  test("dry-run prints payload without calling API", async () => {
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"session":{"lifetime":3600}}', dryRun: true });
    expect(fetchCalled).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[dry-run]"));
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify({ session: { lifetime: 3600 } }, null, 2));
  });

  test("dry-run for put shows PUT method", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({ json: '{"a":1}', dryRun: true });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("[dry-run] Would PUT"));
  });

  // --- API error handling ---

  test("handles API errors gracefully", async () => {
    stubFetch(async () => new Response("Bad Request", { status: 400 }));

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ json: '{"a":1}', yes: true })).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Failed to push config"));
  });

  test("shows success message after push", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"a":1}', yes: true });
    expect(errorSpy).toHaveBeenCalledWith("Config pushed successfully.");
  });

  // --- --json takes priority over --file ---

  test("--json takes priority over --file", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify(mockResponse), { status: 200 });
    });

    const configFile = join(tempDir, "should-not-read.json");
    await Bun.write(configFile, JSON.stringify({ from: "file" }));

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"from":"json"}', file: configFile, yes: true });
    expect(JSON.parse(capturedBody)).toEqual({ from: "json" });
  });
});
