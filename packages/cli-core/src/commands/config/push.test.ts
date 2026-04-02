import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config.ts";
import { credentialStoreStubs, gitStubs, promptsStubs, stubFetch } from "../../test/stubs.ts";
import { printDiff, hasConfigChanges } from "./push.ts";

mock.module("../../lib/credential-store.ts", () => credentialStoreStubs);
mock.module("../../lib/git.ts", () => gitStubs);
mock.module("@inquirer/prompts", () => promptsStubs);
mock.module("../../lib/spinner.ts", () => ({
  withSpinner: async (msg: string, fn: () => Promise<unknown>) => {
    console.error(msg);
    const result = await fn();
    return result;
  },
}));

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

  // The "current" config returned by the GET /config call before push.
  // Must differ from mockResponse payloads so hasConfigChanges detects changes.
  const currentConfig = {
    session: { lifetime: 604800 },
    sign_up: { mode: "restricted" },
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

    stubFetch(async (_input, init) => {
      const isGet = !init?.method || init.method === "GET";
      const body = isGet ? currentConfig : mockResponse;
      return new Response(JSON.stringify(body), { status: 200 });
    });
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
      app?: string;
      instance?: string;
      file?: string;
      json?: string;
      dryRun?: boolean;
      yes?: boolean;
      destructive?: boolean;
    } = {},
  ) {
    const { configPatch } = await import("./push.ts");
    return configPatch(options);
  }

  async function runConfigPut(
    options: {
      app?: string;
      instance?: string;
      file?: string;
      json?: string;
      dryRun?: boolean;
      yes?: boolean;
      destructive?: boolean;
    } = {},
  ) {
    const { configPut } = await import("./push.ts");
    return configPut(options);
  }

  // --- Shared error cases ---

  test("errors when no profile is linked", async () => {
    await expect(runConfigPatch({ json: '{"a":1}' })).rejects.toThrow("No Clerk project linked");
  });

  test("errors when CLERK_PLATFORM_API_KEY is missing", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(runConfigPatch({ json: '{"a":1}', yes: true })).rejects.toThrow(
      "Not authenticated",
    );
  });

  test("errors when no input source is provided", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    // Without --file or --json, falls through to stdin which yields empty input
    await expect(runConfigPatch()).rejects.toThrow("No input");
  });

  test("errors on invalid JSON input", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ json: "not-json" })).rejects.toThrow("Invalid JSON");
  });

  test("errors when JSON is an array", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ json: "[1,2,3]" })).rejects.toThrow(
      "Config must be a JSON object",
    );
  });

  test("errors when --file points to nonexistent file", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ file: "/tmp/does-not-exist.json" })).rejects.toThrow(
      "File not found",
    );
  });

  // --- PATCH happy paths ---

  test("patch sends PATCH method with --json input", async () => {
    let capturedMethod = "";
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method) {
        capturedMethod = init.method;
        capturedBody = init.body as string;
      }
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
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

  test("patch supports --app without a linked profile", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      const url = input.toString();
      if (init?.method) {
        capturedUrl = url;
        return new Response(JSON.stringify(mockResponse), { status: 200 });
      }
      if (url.includes("/config")) {
        return new Response(JSON.stringify(currentConfig), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          application_id: "app_1",
          instances: [{ instance_id: "ins_dev", environment_type: "development" }],
        }),
        { status: 200 },
      );
    });

    await runConfigPatch({
      app: "app_1",
      json: '{"session":{"lifetime":3600}}',
      yes: true,
    });
    expect(capturedUrl).toContain("/instances/ins_dev/");
  });

  test("patch reads config from --file", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method) capturedBody = init.body as string;
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Updating config on app_1 (development)"),
    );
  });

  // --- PUT happy paths ---

  test("put sends PUT method", async () => {
    let capturedMethod = "";
    stubFetch(async (_input, init) => {
      if (init?.method) capturedMethod = init.method;
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
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
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Replacing config on app_1 (development)"),
    );
  });

  // --- config_version stripping ---

  test("put strips config_version from payload before sending", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method) capturedBody = init.body as string;
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({
      json: '{"config_version":42,"session":{"lifetime":3600}}',
      yes: true,
    });
    expect(JSON.parse(capturedBody)).toEqual({ session: { lifetime: 3600 } });
  });

  test("patch strips config_version from payload before sending", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method) capturedBody = init.body as string;
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({
      json: '{"config_version":42,"session":{"lifetime":3600}}',
      yes: true,
    });
    expect(JSON.parse(capturedBody)).toEqual({ session: { lifetime: 3600 } });
  });

  // --- --destructive flag ---

  test("patch sends ?destructive=true when --destructive is set", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method) capturedUrl = input.toString();
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({
      json: '{"session":null}',
      yes: true,
      destructive: true,
    });
    expect(capturedUrl).toContain("?destructive=true");
  });

  test("put sends ?destructive=true when --destructive is set", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method) capturedUrl = input.toString();
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({
      json: '{"session":null}',
      yes: true,
      destructive: true,
    });
    expect(capturedUrl).toContain("?destructive=true");
  });

  test("does not send ?destructive=true by default", async () => {
    let capturedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method) capturedUrl = input.toString();
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"session":{"lifetime":3600}}', yes: true });
    expect(capturedUrl).not.toContain("destructive");
  });

  // --- No-op when unchanged ---

  test("patch skips API call when payload matches current config", async () => {
    let mutatingCallMade = false;
    stubFetch(async (_input, init) => {
      if (init?.method) mutatingCallMade = true;
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    // Send a payload that matches the current config for the patched key
    await runConfigPatch({ json: '{"session":{"lifetime":604800}}', yes: true });
    expect(mutatingCallMade).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("No changes detected");
  });

  test("put skips API call when payload matches current config", async () => {
    let mutatingCallMade = false;
    stubFetch(async (_input, init) => {
      if (init?.method) mutatingCallMade = true;
      return new Response(JSON.stringify(currentConfig), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({
      json: JSON.stringify(currentConfig),
      yes: true,
    });
    expect(mutatingCallMade).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("No changes detected");
  });

  test("put detects no changes when current config has config_version (pull→put roundtrip)", async () => {
    let mutatingCallMade = false;
    const configWithVersion = { ...currentConfig, config_version: 42 };
    stubFetch(async (_input, init) => {
      if (init?.method) mutatingCallMade = true;
      return new Response(JSON.stringify(configWithVersion), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    // Simulate pull→put: payload includes config_version from the pull output
    await runConfigPut({ json: JSON.stringify(configWithVersion), yes: true });
    expect(mutatingCallMade).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith("No changes detected");
  });

  // --- Instance targeting ---

  test("targets development instance by default", async () => {
    let requestedUrl = "";
    stubFetch(async (input, init) => {
      if (init?.method) requestedUrl = input.toString();
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
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
    stubFetch(async (input, init) => {
      if (init?.method) requestedUrl = input.toString();
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
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
    stubFetch(async (input, init) => {
      if (init?.method) requestedUrl = input.toString();
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPut({
      json: '{"a":1}',
      instance: "ins_custom_123",
      yes: true,
    });
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

    await runConfigPatch({
      json: '{"session":{"lifetime":3600}}',
      dryRun: true,
    });
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
    stubFetch(async (_input, init) => {
      if (!init?.method) return new Response(JSON.stringify(currentConfig), { status: 200 });
      return new Response("Bad Request", { status: 400 });
    });

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await expect(runConfigPatch({ json: '{"a":1}', yes: true })).rejects.toThrow("API error");
  });

  test("shows success message after push", async () => {
    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({ json: '{"a":1}', yes: true });
    expect(errorSpy).toHaveBeenCalledWith("Config pushed successfully");
  });

  // --- --json takes priority over --file ---

  test("--json takes priority over --file", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      if (init?.method) capturedBody = init.body as string;
      const body = init?.method ? mockResponse : currentConfig;
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const configFile = join(tempDir, "should-not-read.json");
    await Bun.write(configFile, JSON.stringify({ from: "file" }));

    await setProfile(process.cwd(), {
      workspaceId: "org_1",
      appId: "app_1",
      instances: { development: "ins_dev" },
    });

    await runConfigPatch({
      json: '{"from":"json"}',
      file: configFile,
      yes: true,
    });
    expect(JSON.parse(capturedBody)).toEqual({ from: "json" });
  });
});

describe("printDiff", () => {
  let errorSpy: ReturnType<typeof spyOn>;
  let lines: string[];

  beforeEach(() => {
    lines = [];
    errorSpy = spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      // Strip ANSI codes for easier assertion
      lines.push(String(args[0]).replace(/\x1b\[[0-9;]*m/g, ""));
    });
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test("patch mode: shows only changed leaf values", () => {
    const current = { session: { lifetime: 604800, cookie: "__session" } };
    const patch = { session: { lifetime: 3600 } };

    printDiff(current, patch, true);

    expect(lines).toEqual(["  session:", "    lifetime:", "      - 604800", "      + 3600"]);
  });

  test("patch mode: skips unchanged keys", () => {
    const current = { session: { lifetime: 3600 }, sign_up: { mode: "public" } };
    const patch = { session: { lifetime: 3600 } };

    printDiff(current, patch, true);

    expect(lines).toEqual([]);
  });

  test("patch mode: shows new keys being added", () => {
    const current = {};
    const patch = { session: { lifetime: 3600 } };

    printDiff(current, patch, true);

    expect(lines).toEqual(["  session:", '    + {"lifetime":3600}']);
  });

  test("patch mode: ignores keys not in patch", () => {
    const current = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    const patch = { session: { lifetime: 3600 } };

    printDiff(current, patch, true);

    // sign_up should not appear
    expect(lines.some((l) => l.includes("sign_up"))).toBe(false);
  });

  test("put mode: shows removed keys", () => {
    const current = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    const payload = { session: { lifetime: 604800 } };

    printDiff(current, payload, false);

    // session is unchanged, sign_up is being removed
    expect(lines.some((l) => l.includes("sign_up"))).toBe(true);
    expect(lines.some((l) => l.includes("- {"))).toBe(true);
  });

  test("put mode: shows both old and new for changed values", () => {
    const current = { session: { lifetime: 604800 } };
    const payload = { session: { lifetime: 3600 } };

    printDiff(current, payload, false);

    expect(lines).toContainEqual(expect.stringContaining("- 604800"));
    expect(lines).toContainEqual(expect.stringContaining("+ 3600"));
  });

  test("handles deeply nested changes", () => {
    const current = { a: { b: { c: { d: 1 } } } };
    const patch = { a: { b: { c: { d: 2 } } } };

    printDiff(current, patch, true);

    expect(lines).toEqual(["  a:", "    b.c.d:", "      - 1", "      + 2"]);
  });

  test("handles array value changes", () => {
    const current = { allowed: { origins: ["a.com", "b.com"] } };
    const patch = { allowed: { origins: ["a.com", "c.com"] } };

    printDiff(current, patch, true);

    expect(lines).toContainEqual(expect.stringContaining('- ["a.com","b.com"]'));
    expect(lines).toContainEqual(expect.stringContaining('+ ["a.com","c.com"]'));
  });
});

describe("hasConfigChanges", () => {
  test("patch mode: no change when partial payload matches nested values", () => {
    const current = { session: { lifetime: 604800, cookie: "__session" } };
    const payload = { session: { lifetime: 604800 } };

    expect(hasConfigChanges(current, payload, true)).toBe(false);
  });

  test("patch mode: detects change in nested value", () => {
    const current = { session: { lifetime: 604800, cookie: "__session" } };
    const payload = { session: { lifetime: 3600 } };

    expect(hasConfigChanges(current, payload, true)).toBe(true);
  });

  test("put mode: detects removal of keys not in payload", () => {
    const current = { session: { lifetime: 604800 }, sign_up: { mode: "public" } };
    const payload = { session: { lifetime: 604800 } };

    expect(hasConfigChanges(current, payload, false)).toBe(true);
  });

  test("put mode: no change when both sides match", () => {
    const current = { session: { lifetime: 604800 } };
    const payload = { session: { lifetime: 604800 } };

    expect(hasConfigChanges(current, payload, false)).toBe(false);
  });
});
