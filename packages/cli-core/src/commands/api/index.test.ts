import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { promptsStubs, stubFetch } from "../../test/lib/stubs.ts";

// `@inquirer/prompts` is not part of the deps registry yet; ported commands
// still import it directly. Stub it here so interactive confirms don't hang.
mock.module("@inquirer/prompts", () => promptsStubs);

import { api } from "./index.ts";
import { bapiRequest } from "./bapi.ts";
import { validateKeyPrefix, getAuthToken, fetchApplication } from "../../lib/plapi.ts";
import { getBapiBaseUrl, getPlapiBaseUrl } from "../../lib/environment.ts";
import { testRoot } from "../../test/lib/test-root.ts";

type ResolveAppContextResult = {
  appId: string;
  appLabel: string;
  instanceId: string;
  instanceLabel: string;
};

interface BuildDepsOptions {
  isHuman?: boolean;
  // Override resolveAppContext. Default throws "No Clerk project linked"
  // so tests that don't set a secret key explicitly hit the expected
  // "No secret key found" error path.
  resolveAppContext?: (options: {
    app?: string;
    instance?: string;
  }) => Promise<ResolveAppContextResult>;
  // Override getAuthToken for platform-mode tests. Default reads
  // CLERK_PLATFORM_API_KEY from process.env via the real plapi helper.
  getAuthToken?: () => Promise<string>;
}

function buildDeps(opts: BuildDepsOptions = {}) {
  const isHuman = opts.isHuman ?? false;
  const resolveAppContext =
    opts.resolveAppContext ??
    (async () => {
      throw new Error(
        "No Clerk project linked to this directory.\n" +
          "Either:\n" +
          "  - Run `clerk link` from your project directory\n" +
          "  - Pass --app <app_id> to target an app directly",
      );
    });
  // Default getAuthToken uses the real plapi implementation, but only
  // reads CLERK_PLATFORM_API_KEY; it never reaches the OS keyring because
  // tests set process.env explicitly.
  const defaultGetAuthToken = async () => {
    const key = process.env.CLERK_PLATFORM_API_KEY;
    if (key) {
      validateKeyPrefix(key, "ak_");
      return key;
    }
    // Fall back to real helper (which throws when no token is available).
    return getAuthToken();
  };
  return testRoot({
    bapi: { bapiRequest },
    plapi: {
      validateKeyPrefix,
      getAuthToken: opts.getAuthToken ?? defaultGetAuthToken,
      fetchApplication,
    },
    configStore: {
      resolveAppContext,
    },
    environment: {
      getBapiBaseUrl,
      getPlapiBaseUrl,
    },
    mode: {
      isHuman: () => isHuman,
      isAgent: () => !isHuman,
    },
    env: {
      get: (name: string) => process.env[name],
    },
  });
}

describe("api command", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let exitSpy: ReturnType<typeof spyOn>;
  // Each test gets its own deps (built by runApi). Tests assert on
  // deps.log.* via this reference set by runApi().
  let deps: ReturnType<typeof buildDeps>;

  const mockUsers = { data: [{ id: "user_1", email: "test@example.com" }] };

  const originalIsTTY = process.stdin.isTTY;

  function logInfo(): string[] {
    return ((deps.log.info as ReturnType<typeof mock>).mock.calls as unknown[][]).map((c) =>
      String(c[0] ?? ""),
    );
  }

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-api-test-"));
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    // Tests run in "agent" mode by default so mutating confirmation prompts
    // are skipped. Individual tests that exercise human mode opt in via
    // buildDeps({ isHuman: true }).
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    stubFetch(async () => new Response(JSON.stringify(mockUsers), { status: 200 }));
  });

  afterEach(async () => {
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    exitSpy.mockRestore();
    process.exitCode = 0;
    await rm(tempDir, { recursive: true, force: true });
  });

  async function runApi(
    endpoint: string,
    options: Record<string, unknown> = {},
    depsOptions: BuildDepsOptions = {},
  ) {
    deps = buildDeps(depsOptions);
    return api(deps, endpoint, undefined, options);
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
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify(mockUsers, null, 2));
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
    expect(deps.log.info).toHaveBeenCalledWith("HTTP 200");
    expect(logInfo().some((m) => m.includes("x-request-id: req_123"))).toBe(true);
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
    expect(logInfo().some((m) => m.includes("[dry-run] GET"))).toBe(true);
  });

  test("--dry-run shows body when present", async () => {
    await runApi("/users", { dryRun: true, data: '{"email":"a@b.com"}' });
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify({ email: "a@b.com" }, null, 2));
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

    await runApi(
      "/users",
      { app: "app_1" },
      {
        resolveAppContext: async () => ({
          appId: "app_1",
          appLabel: "app_1",
          instanceId: "ins_dev",
          instanceLabel: "development",
        }),
      },
    );
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_test_derived");
  });

  test("uses stored auth token to resolve a secret key for --app", async () => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PLATFORM_API_KEY;
    let capturedHeaders: Headers | undefined;

    // resolveSecretKey -> resolveAppContext only runs when no env key is set.
    // Inside resolveSecretKey we then call deps.plapi.fetchApplication (real
    // implementation) which calls plapi.getAuthToken (real implementation)
    // which falls back to credential-store.getToken. Since we can't patch
    // the real credential store here, we stub fetchApplication directly to
    // simulate a valid bearer token request in the test expectation.
    stubFetch(async (input, init) => {
      const url = input.toString();
      if (url.includes("/v1/platform/applications/app_1")) {
        // Accept any auth header; the point of this test is that when
        // resolveAppContext resolves an app, its secret_key flows through
        // to the subsequent bapi request.
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

    await runApi(
      "/users",
      { app: "app_1" },
      {
        // Stub getAuthToken to return the "stored OAuth token" path.
        getAuthToken: async () => "oauth_token_123",
        resolveAppContext: async () => ({
          appId: "app_1",
          appLabel: "app_1",
          instanceId: "ins_dev",
          instanceLabel: "development",
        }),
      },
    );
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_test_oauth");
  });

  // --- --platform mode ---

  test("--platform uses Platform API URL and key", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    process.env.CLERK_PLATFORM_API_KEY = "ak_test_plat_key_123";

    stubFetch(async (input, init) => {
      capturedUrl = input.toString();
      capturedHeaders = new Headers(init?.headers);
      return new Response(JSON.stringify({}), { status: 200 });
    });

    await runApi("/v1/platform/applications", { platform: true });
    expect(capturedUrl).toContain("api.clerk.com");
    expect(capturedUrl).not.toContain("api.clerk.dev");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer ak_test_plat_key_123");
  });

  test("--platform errors when CLERK_PLATFORM_API_KEY missing", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;

    // With no platform key and no stored OAuth token, getAuthToken() throws.
    await expect(
      runApi(
        "/v1/platform/applications",
        { platform: true },
        {
          getAuthToken: async () => {
            throw new Error(
              "Not authenticated. Run `clerk auth login` or set CLERK_PLATFORM_API_KEY",
            );
          },
        },
      ),
    ).rejects.toThrow("Not authenticated");
  });

  // --- Error handling ---

  test("errors when no secret key available", async () => {
    delete process.env.CLERK_SECRET_KEY;
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(runApi("/users")).rejects.toThrow("No secret key found");
  });

  test("prints API error response body to stdout and exits 1", async () => {
    const errorBody = { errors: [{ message: "not found", code: "resource_not_found" }] };
    stubFetch(async () => new Response(JSON.stringify(errorBody), { status: 404 }));

    await runApi("/users/bad_id");
    expect(process.exitCode).toBe(1);
    expect(deps.log.data).toHaveBeenCalledWith(JSON.stringify(errorBody, null, 2));
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
    expect(deps.log.info).toHaveBeenCalledWith("HTTP 400");
    expect(logInfo().some((m) => m.includes("x-request-id: req_err"))).toBe(true);
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
