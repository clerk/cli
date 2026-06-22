import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { CliError, ERROR_CODE, UserAbortError } from "../../lib/errors.ts";
import {
  useCaptureLog,
  credentialStoreStubs,
  gitStubs,
  configStubs,
  libPromptsStubs,
  stubFetch,
} from "../../test/lib/stubs.ts";

let mockStoredToken: string | null = null;
mock.module("../../lib/credential-store.ts", () => ({
  ...credentialStoreStubs,
  getToken: async () => mockStoredToken,
  getValidToken: async () => mockStoredToken,
}));
mock.module("../../lib/git.ts", () => gitStubs);

let _mode = "human";
mock.module("../../mode.ts", () => ({
  setMode: (m: string) => {
    _mode = m;
  },
  getMode: () => _mode,
  isAgent: () => _mode === "agent",
  isHuman: () => _mode !== "agent",
}));

type Profile = { workspaceId: string; appId: string; instances: Record<string, string> };
const _profiles: Record<string, Profile> = {};
mock.module("../../lib/config.ts", () => ({
  ...configStubs,
  setProfile: async (path: string, profile: Profile) => {
    _profiles[path] = profile;
  },
  resolveProfile: async (cwd: string) => {
    if (_profiles[cwd])
      return { path: cwd, profile: _profiles[cwd], resolvedVia: "directory" as const };
    return undefined;
  },
  resolveInstanceId: (profile: Profile, flag?: string) => {
    const aliases: Record<string, string> = {
      dev: "development",
      development: "development",
      prod: "production",
      production: "production",
    };
    if (!flag) return { id: profile.instances.development, label: "development" };
    const env = aliases[flag];
    if (!env) return { id: flag, label: flag };
    const id = profile.instances[env];
    if (!id) throw new Error(`No ${env} instance configured.`);
    return { id, label: env };
  },
  resolveFetchedApplicationInstance: (
    appId: string,
    app: { instances: Array<any> },
    flag?: string,
  ) => {
    const aliases: Record<string, string> = {
      dev: "development",
      development: "development",
      prod: "production",
      production: "production",
    };

    if (!flag) {
      const development = app.instances.find((entry) => entry.environment_type === "development");
      if (!development) throw new Error(`No development instance found for application ${appId}.`);
      return {
        found: true as const,
        instance: development,
        instanceId: development.instance_id,
        instanceLabel: "development",
      };
    }

    const env = aliases[flag];
    if (env) {
      const matched = app.instances.find((entry) => entry.environment_type === env);
      if (!matched) throw new Error(`No ${env} instance found for application ${appId}.`);
      return {
        found: true as const,
        instance: matched,
        instanceId: matched.instance_id,
        instanceLabel: env,
      };
    }

    const matched = app.instances.find((entry) => entry.instance_id === flag);
    if (matched) {
      return {
        found: true as const,
        instance: matched,
        instanceId: matched.instance_id,
        instanceLabel: flag,
      };
    }

    return {
      found: false as const,
      instanceId: flag,
      instanceLabel: flag,
    };
  },
  resolveAppContext: async (options: { app?: string; instance?: string }) => {
    if (options.app) {
      const aliases: Record<string, string> = {
        dev: "development",
        development: "development",
        prod: "production",
        production: "production",
      };
      if (!options.instance) {
        return {
          appId: options.app,
          appLabel: options.app,
          instanceId: "ins_dev",
          instanceLabel: "development",
        };
      }
      const env = aliases[options.instance];
      if (!env) {
        return {
          appId: options.app,
          appLabel: options.app,
          instanceId: options.instance,
          instanceLabel: options.instance,
        };
      }
      return {
        appId: options.app,
        appLabel: options.app,
        instanceId: env === "production" ? "ins_prod" : "ins_dev",
        instanceLabel: env,
      };
    }

    const profile = _profiles[process.cwd()];
    if (!profile) {
      throw new CliError("No Clerk project linked to this directory.", {
        code: ERROR_CODE.NOT_LINKED,
      });
    }
    const instance = !options.instance
      ? { id: profile.instances.development, label: "development" }
      : (() => {
          const aliases: Record<string, string> = {
            dev: "development",
            development: "development",
            prod: "production",
            production: "production",
          };
          const env = aliases[options.instance];
          if (!env) return { id: options.instance, label: options.instance };
          const id = profile.instances[env];
          if (!id) throw new Error(`No ${env} instance configured.`);
          return { id, label: env };
        })();

    return {
      appId: profile.appId,
      appLabel: profile.appId,
      instanceId: instance.id,
      instanceLabel: instance.label,
    };
  },
}));

const mockConfirm = mock(async (_config?: unknown) => true);
mock.module("../../lib/prompts.ts", () => ({
  ...libPromptsStubs,
  confirm: (config: unknown) => mockConfirm(config),
}));

const { _setConfigDir } = (await import("../../lib/config.ts")) as any;
const { setMode } = (await import("../../mode.ts")) as any;

describe("api command", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  const mockUsers = { data: [{ id: "user_1", email: "test@example.com" }] };

  const originalIsTTY = process.stdin.isTTY;

  beforeEach(async () => {
    Object.keys(_profiles).forEach((k) => delete _profiles[k]);
    mockStoredToken = null;
    _mode = "human";
    tempDir = await mkdtemp(join(tmpdir(), "clerk-api-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    setMode("agent"); // skip confirmation prompts
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    stubFetch(async () => new Response(JSON.stringify(mockUsers), { status: 200 }));
    mockConfirm.mockReset();
    mockConfirm.mockResolvedValue(true);
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    process.exitCode = 0;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function runApi(endpoint: string, options: Record<string, unknown> = {}) {
    const { api } = await import("./index.ts");
    return api(endpoint, undefined, options);
  }

  // --- GET requests ---

  test("sends GET request with CLERK_SECRET_KEY", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Headers | undefined;
    stubFetch(async (input, init) => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify(mockUsers), { status: 200 });
    });

    await runApi("/users");
    expect(capturedUrl).toContain("/v1/users");
    expect(capturedMethod).toBe("GET");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_test_123");
    expect(captured.out).toContain(JSON.stringify(mockUsers, null, 2));
  });

  test("defaults to GET when no body provided", async () => {
    let capturedMethod = "";
    stubFetch(async (_input, init) => {
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users");
    expect(capturedMethod).toBe("GET");
  });

  // --- POST requests ---

  test("defaults to POST when -d data is provided", async () => {
    let capturedMethod = "";
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      capturedMethod = init?.method ?? "GET";
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users", { data: '{"email_address":["a@b.com"]}' });
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody)).toEqual({ email_address: ["a@b.com"] });
  });

  // --- Explicit method ---

  test("uses explicit -X method override", async () => {
    let capturedMethod = "";
    stubFetch(async (_input, init) => {
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users/user_1", { method: "PATCH", data: '{"first_name":"Alice"}' });
    expect(capturedMethod).toBe("PATCH");
  });

  test("method is case-insensitive", async () => {
    let capturedMethod = "";
    stubFetch(async (_input, init) => {
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users", { method: "delete" });
    expect(capturedMethod).toBe("DELETE");
  });

  // --- --file option ---

  test("reads body from --file", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const bodyFile = join(tempDir, "body.json");
    await Bun.write(bodyFile, JSON.stringify({ first_name: "Bob" }));

    await runApi("/users/user_1", { method: "PATCH", file: bodyFile });
    expect(JSON.parse(capturedBody)).toEqual({ first_name: "Bob" });
  });

  test("errors when --file does not exist", async () => {
    await expect(runApi("/users", { file: "/tmp/nonexistent-file.json" })).rejects.toThrow(
      "File not found",
    );
  });

  // --- --include option ---

  test("--include shows response headers", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify(mockUsers), {
          status: 200,
          headers: { "x-request-id": "req_123" },
        }),
    );

    await runApi("/users", { include: true });
    expect(captured.err).toContain("HTTP 200");
    expect(captured.err).toContain("x-request-id: req_123");
  });

  // --- --dry-run option ---

  test("--dry-run shows request without executing", async () => {
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users", { dryRun: true });
    expect(fetchCalled).toBe(false);
    expect(captured.err).toContain("[dry-run] GET");
  });

  test("--dry-run shows body when present", async () => {
    await runApi("/users", { dryRun: true, data: '{"email":"a@b.com"}' });
    expect(captured.out).toContain(JSON.stringify({ email: "a@b.com" }, null, 2));
  });

  // --- --secret-key override ---

  test("--secret-key overrides env var", async () => {
    let capturedHeaders: Headers | undefined;
    stubFetch(async (_input, init) => {
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users", { secretKey: "sk_live_override" });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_live_override");
  });

  test("rejects a platform key passed as --secret-key", async () => {
    await expect(runApi("/users", { secretKey: "ak_test_wrong" })).rejects.toThrow(
      "Expected a Secret key",
    );
  });

  test("uses --app to resolve a secret key without a linked profile", async () => {
    delete process.env.CLERK_SECRET_KEY;
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
    let capturedHeaders: Headers | undefined;

    stubFetch(async (input, init) => {
      const url = input.toString();
      if (url.includes("/v1/platform/applications/app_1")) {
        return new Response(
          JSON.stringify({
            application_id: "app_1",
            instances: [
              {
                instance_id: "ins_dev",
                environment_type: "development",
                secret_key: "sk_test_derived",
              },
            ],
          }),
          { status: 200 },
        );
      }

      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users", { app: "app_1" });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_test_derived");
  });

  test("uses stored auth token to resolve a secret key for --app", async () => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PLATFORM_API_KEY;
    mockStoredToken = "oauth_token_123";
    let capturedHeaders: Headers | undefined;

    stubFetch(async (input, init) => {
      const url = input.toString();
      if (url.includes("/v1/platform/applications/app_1")) {
        expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer oauth_token_123");
        return new Response(
          JSON.stringify({
            application_id: "app_1",
            instances: [
              {
                instance_id: "ins_dev",
                environment_type: "development",
                secret_key: "sk_test_oauth",
              },
            ],
          }),
          { status: 200 },
        );
      }

      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/users", { app: "app_1" });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_test_oauth");
  });

  // --- --platform mode ---

  test("--platform uses Platform API URL and key", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    process.env.CLERK_PLATFORM_API_KEY = "plat_key_123";

    stubFetch(async (input, init) => {
      capturedUrl = input.toString();
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/v1/platform/applications", { platform: true });
    expect(capturedUrl).toContain("api.clerk.com");
    expect(capturedUrl).not.toContain("api.clerk.dev");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer plat_key_123");
  });

  test("--platform errors when CLERK_PLATFORM_API_KEY missing", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(runApi("/v1/platform/applications", { platform: true })).rejects.toThrow(
      "Not authenticated",
    );
  });

  // --- --fapi mode ---

  test("--fapi resolves the FAPI host from the publishable key and sends no auth header", async () => {
    delete process.env.CLERK_SECRET_KEY;
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
    const pk = `pk_test_${btoa("clerk.example.com$")}`;
    let fapiUrl = "";
    let fapiAuth: string | null = "unset";

    stubFetch(async (input, init) => {
      const url = input.toString();
      if (url.includes("/v1/platform/applications/app_1")) {
        return new Response(
          JSON.stringify({
            application_id: "app_1",
            instances: [
              { instance_id: "ins_dev", environment_type: "development", publishable_key: pk },
            ],
          }),
          { status: 200 },
        );
      }
      fapiUrl = url;
      fapiAuth = new Headers(init?.headers).get("Authorization");
      return new Response(JSON.stringify({ environment: "ok" }), { status: 200 });
    });

    await runApi("/environment", { fapi: true, app: "app_1", instance: "dev" });
    expect(fapiUrl).toContain("https://clerk.example.com/v1/environment");
    expect(fapiUrl).toContain("_clerk_js_version=");
    expect(fapiAuth).toBeNull();
  });

  test("--fapi cannot be combined with --platform", async () => {
    await expect(runApi("/environment", { fapi: true, platform: true })).rejects.toThrow(
      "cannot be combined",
    );
  });

  test("--fapi prints API error response body to stdout and exits 1", async () => {
    setMode("human");
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
    const pk = `pk_test_${btoa("clerk.example.com$")}`;
    const errorBody = { errors: [{ message: "no environment", code: "not_found" }] };

    stubFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/v1/platform/applications/app_1")) {
        return new Response(
          JSON.stringify({
            application_id: "app_1",
            instances: [
              { instance_id: "ins_dev", environment_type: "development", publishable_key: pk },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify(errorBody), { status: 404 });
    });

    await runApi("/environment", { fapi: true, app: "app_1" });
    expect(process.exitCode).toBe(1);
    expect(captured.out).toContain(JSON.stringify(errorBody, null, 2));
  });

  test("--fapi without --app and no linked project errors with NOT_LINKED guidance", async () => {
    delete process.env.CLERK_SECRET_KEY;

    await expect(runApi("/environment", { fapi: true })).rejects.toThrow(/clerk link|--app/);
  });

  test.each([
    ["/environment", "/v1/environment"],
    ["/v1/environment", "/v1/environment"],
  ])("--fapi: %s resolves to the same FAPI path %s", async (input, expectedPath) => {
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
    const pk = `pk_test_${btoa("clerk.example.com$")}`;
    let capturedPath = "";

    stubFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/v1/platform/applications/app_1")) {
        return new Response(
          JSON.stringify({
            application_id: "app_1",
            instances: [
              { instance_id: "ins_dev", environment_type: "development", publishable_key: pk },
            ],
          }),
          { status: 200 },
        );
      }
      capturedPath = new URL(url).pathname;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi(input, { fapi: true, app: "app_1" });
    expect(capturedPath).toBe(expectedPath);
  });

  test("--fapi + --secret-key emits a warning that --secret-key is ignored", async () => {
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_platform";
    const pk = `pk_test_${btoa("clerk.example.com$")}`;

    stubFetch(async (input) => {
      const url = input.toString();
      if (url.includes("/v1/platform/applications/app_1")) {
        return new Response(
          JSON.stringify({
            application_id: "app_1",
            instances: [
              { instance_id: "ins_dev", environment_type: "development", publishable_key: pk },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/environment", { fapi: true, app: "app_1", secretKey: "sk_test_ignored" });
    expect(captured.err).toMatch(/--secret-key is ignored/);
  });

  test("--fapi + --dry-run does not make any network request", async () => {
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/environment", { fapi: true, app: "app_1", dryRun: true });
    expect(fetchCalled).toBe(false);
    expect(captured.err).toContain("[dry-run] GET <fapi-host>");
  });

  // --- Error handling ---

  test("errors when no secret key available", async () => {
    delete process.env.CLERK_SECRET_KEY;

    await expect(runApi("/users")).rejects.toThrow("No secret key found");
  });

  test("prints API error response body to stdout and exits 1", async () => {
    setMode("human");
    const errorBody = { errors: [{ message: "not found", code: "resource_not_found" }] };
    stubFetch(async () => new Response(JSON.stringify(errorBody), { status: 404 }));

    await runApi("/users/bad_id");
    expect(process.exitCode).toBe(1);
    expect(captured.out).toContain(JSON.stringify(errorBody, null, 2));
    expect(captured.err).toContain("Failed");
    expect(captured.err).not.toContain("Done");
  });

  test("shows Paused with instructions when a confirmation prompt is cancelled", async () => {
    setMode("human");
    mockConfirm.mockImplementation(async () => {
      throw new UserAbortError();
    });

    await expect(
      runApi("/users", { method: "POST", data: "{}", yes: false }),
    ).rejects.toBeInstanceOf(UserAbortError);
    expect(captured.err).toContain("Paused");
    expect(captured.err).toContain("Run this command again to continue.");
    expect(captured.err).not.toContain("Done");
  });

  test("--include shows headers on error responses too", async () => {
    stubFetch(
      async () =>
        new Response('{"error":"bad"}', {
          status: 400,
          headers: { "x-request-id": "req_err" },
        }),
    );

    await runApi("/users", { include: true });
    expect(process.exitCode).toBe(1);
    expect(captured.err).toContain("HTTP 400");
    expect(captured.err).toContain("x-request-id: req_err");
  });

  // --- -d takes priority over --file ---

  test("-d takes priority over --file", async () => {
    let capturedBody = "";
    stubFetch(async (_input, init) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    });

    const bodyFile = join(tempDir, "should-not-read.json");
    await Bun.write(bodyFile, JSON.stringify({ from: "file" }));

    await runApi("/users", { data: '{"from":"inline"}', file: bodyFile });
    expect(JSON.parse(capturedBody)).toEqual({ from: "inline" });
  });
});
