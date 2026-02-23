import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { _setConfigDir, setProfile } from "../../lib/config";
import { setMode } from "../../mode";

describe("api command", () => {
  const originalEnv = { ...process.env };
  const originalFetch = globalThis.fetch;
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;

  const mockUsers = { data: [{ id: "user_1", email: "test@example.com" }] };

  const originalIsTTY = process.stdin.isTTY;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-api-test-"));
    _setConfigDir(tempDir);
    process.env.CLERK_SECRET_KEY = "sk_test_123";
    setMode("agent"); // skip confirmation prompts
    // Prevent resolveBody from trying to read stdin in tests
    Object.defineProperty(process.stdin, "isTTY", { value: true, writable: true, configurable: true });

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });

    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockUsers), { status: 200 });
  });

  afterEach(async () => {
    _setConfigDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    Object.defineProperty(process.stdin, "isTTY", { value: originalIsTTY, writable: true, configurable: true });
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  async function runApi(endpoint: string, options: Record<string, unknown> = {}) {
    const { api } = await import("./index");
    return api(endpoint, options);
  }

  // --- GET requests ---

  test("sends GET request with CLERK_SECRET_KEY", async () => {
    let capturedUrl = "";
    let capturedMethod = "";
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedMethod = init?.method ?? "GET";
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response(JSON.stringify(mockUsers), { status: 200 });
    };

    await runApi("/users");
    expect(capturedUrl).toContain("/v1/users");
    expect(capturedMethod).toBe("GET");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_test_123");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(mockUsers, null, 2));
  });

  test("defaults to GET when no body provided", async () => {
    let capturedMethod = "";
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await runApi("/users");
    expect(capturedMethod).toBe("GET");
  });

  // --- POST requests ---

  test("defaults to POST when -d data is provided", async () => {
    let capturedMethod = "";
    let capturedBody = "";
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method ?? "GET";
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await runApi("/users", { data: '{"email_address":["a@b.com"]}' });
    expect(capturedMethod).toBe("POST");
    expect(JSON.parse(capturedBody)).toEqual({ email_address: ["a@b.com"] });
  });

  // --- Explicit method ---

  test("uses explicit -X method override", async () => {
    let capturedMethod = "";
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await runApi("/users/user_1", { method: "PATCH", data: '{"first_name":"Alice"}' });
    expect(capturedMethod).toBe("PATCH");
  });

  test("method is case-insensitive", async () => {
    let capturedMethod = "";
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedMethod = init?.method ?? "GET";
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await runApi("/users", { method: "delete" });
    expect(capturedMethod).toBe("DELETE");
  });

  // --- --file option ---

  test("reads body from --file", async () => {
    let capturedBody = "";
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const bodyFile = join(tempDir, "body.json");
    await Bun.write(bodyFile, JSON.stringify({ first_name: "Bob" }));

    await runApi("/users/user_1", { method: "PATCH", file: bodyFile });
    expect(JSON.parse(capturedBody)).toEqual({ first_name: "Bob" });
  });

  test("errors when --file does not exist", async () => {
    await expect(
      runApi("/users", { file: "/tmp/nonexistent-file.json" }),
    ).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("File not found"),
    );
  });

  // --- --include option ---

  test("--include shows response headers", async () => {
    globalThis.fetch = async () =>
      new Response(JSON.stringify(mockUsers), {
        status: 200,
        headers: { "x-request-id": "req_123" },
      });

    await runApi("/users", { include: true });
    expect(errorSpy).toHaveBeenCalledWith("HTTP 200");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("x-request-id: req_123"));
  });

  // --- --dry-run option ---

  test("--dry-run shows request without executing", async () => {
    let fetchCalled = false;
    globalThis.fetch = async () => {
      fetchCalled = true;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await runApi("/users", { dryRun: true });
    expect(fetchCalled).toBe(false);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("[dry-run] GET"),
    );
  });

  test("--dry-run shows body when present", async () => {
    await runApi("/users", { dryRun: true, data: '{"email":"a@b.com"}' });
    expect(logSpy).toHaveBeenCalledWith(
      JSON.stringify({ email: "a@b.com" }, null, 2),
    );
  });

  // --- --secret-key override ---

  test("--secret-key overrides env var", async () => {
    let capturedHeaders: Headers | undefined;
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await runApi("/users", { secretKey: "sk_live_override" });
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer sk_live_override");
  });

  // --- --platform mode ---

  test("--platform uses Platform API URL and key", async () => {
    let capturedUrl = "";
    let capturedHeaders: Headers | undefined;
    process.env.CLERK_PLATFORM_API_KEY = "plat_key_123";

    globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
      capturedUrl = input.toString();
      capturedHeaders = new Headers(init?.headers as HeadersInit);
      return new Response(JSON.stringify({}), { status: 200 });
    };

    await runApi("/v1/platform/applications", { platform: true });
    expect(capturedUrl).toContain("api.clerk.com");
    expect(capturedUrl).not.toContain("api.clerk.dev");
    expect(capturedHeaders?.get("Authorization")).toBe("Bearer plat_key_123");
  });

  test("--platform errors when CLERK_PLATFORM_API_KEY missing", async () => {
    delete process.env.CLERK_PLATFORM_API_KEY;

    await expect(
      runApi("/v1/platform/applications", { platform: true }),
    ).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("CLERK_PLATFORM_API_KEY"),
    );
  });

  // --- Error handling ---

  test("errors when no secret key available", async () => {
    delete process.env.CLERK_SECRET_KEY;

    await expect(runApi("/users")).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("No secret key found"),
    );
  });

  test("prints API error response body to stdout and exits 1", async () => {
    const errorBody = { errors: [{ message: "not found", code: "resource_not_found" }] };
    globalThis.fetch = async () =>
      new Response(JSON.stringify(errorBody), { status: 404 });

    await expect(runApi("/users/bad_id")).rejects.toThrow("process.exit");
    expect(logSpy).toHaveBeenCalledWith(JSON.stringify(errorBody, null, 2));
  });

  test("--include shows headers on error responses too", async () => {
    globalThis.fetch = async () =>
      new Response('{"error":"bad"}', {
        status: 400,
        headers: { "x-request-id": "req_err" },
      });

    await expect(
      runApi("/users", { include: true }),
    ).rejects.toThrow("process.exit");
    expect(errorSpy).toHaveBeenCalledWith("HTTP 400");
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("x-request-id: req_err"));
  });

  // --- -d takes priority over --file ---

  test("-d takes priority over --file", async () => {
    let capturedBody = "";
    globalThis.fetch = async (_: RequestInfo | URL, init?: RequestInit) => {
      capturedBody = init?.body as string;
      return new Response(JSON.stringify({}), { status: 200 });
    };

    const bodyFile = join(tempDir, "should-not-read.json");
    await Bun.write(bodyFile, JSON.stringify({ from: "file" }));

    await runApi("/users", { data: '{"from":"inline"}', file: bodyFile });
    expect(JSON.parse(capturedBody)).toEqual({ from: "inline" });
  });
});
