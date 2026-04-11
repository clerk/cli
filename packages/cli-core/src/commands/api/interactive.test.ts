import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stubFetch } from "../../test/lib/stubs.ts";
import { parseSpec, _setCacheDir } from "./catalog.ts";
import { bapiRequest } from "./bapi.ts";
import { validateKeyPrefix } from "../../lib/plapi.ts";
import { createEnvironment } from "../../lib/environment.ts";

const testEnvironment = createEnvironment();
const getBapiBaseUrl = testEnvironment.getBapiBaseUrl;
const getPlapiBaseUrl = testEnvironment.getPlapiBaseUrl;
import { testRoot } from "../../test/lib/test-root.ts";
import { apiInteractive } from "./interactive.ts";

const MINIMAL_SPEC = `
openapi: "3.0.0"
info:
  title: Test API
  version: "1.0"
paths:
  /users:
    get:
      tags: [Users]
      summary: List all users
      operationId: GetUserList
    post:
      tags: [Users]
      summary: Create a new user
      operationId: CreateUser
      requestBody:
        content:
          application/json:
            schema:
              type: object
  /users/{user_id}:
    get:
      tags: [Users]
      summary: Retrieve a user
      operationId: GetUser
      parameters:
        - name: user_id
          in: path
          description: The ID of the user
`;

// Track mock prompt responses
let selectResponses: unknown[] = [];
let inputResponses: string[] = [];
let confirmResponses: boolean[] = [];
let editorResponses: string[] = [];

// Track fetch calls made by the real api handler
let fetchCalls: { url: string; method: string }[] = [];

function buildDeps(opts: { isHuman: boolean }) {
  return testRoot({
    mode: {
      isHuman: () => opts.isHuman,
      isAgent: () => !opts.isHuman,
    },
    bapi: { bapiRequest },
    plapi: { validateKeyPrefix },
    environment: {
      getBapiBaseUrl,
      getPlapiBaseUrl,
    },
    env: {
      get: (name: string) => process.env[name],
    },
    prompts: {
      select: async () => selectResponses.shift() as never,
      input: async () => inputResponses.shift() as never,
      confirm: async () => confirmResponses.shift() as never,
      editor: async () => (editorResponses.shift() ?? "{}") as never,
    },
  });
}

describe("apiInteractive", () => {
  let tempDir: string;
  let errorSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  const originalFetch = globalThis.fetch;
  const originalIsTTY = process.stdin.isTTY;

  const originalEnv = { ...process.env };

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-interactive-test-"));
    _setCacheDir(tempDir);

    // Pre-populate fresh cache
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now();
    await Bun.write(join(tempDir, "bapi-catalog.json"), JSON.stringify(cached));

    process.env.CLERK_SECRET_KEY = "sk_test_123";
    // Prevent resolveBody from trying to read stdin
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      writable: true,
      configurable: true,
    });

    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    logSpy = spyOn(console, "log").mockImplementation(() => {});
    exitSpy = spyOn(process, "exit").mockImplementation(() => {
      throw new Error("process.exit");
    });
    // Capture fetch calls from the real api handler
    stubFetch(async (input, init) => {
      fetchCalls.push({ url: input.toString(), method: init?.method ?? "GET" });
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    // Reset tracking
    selectResponses = [];
    inputResponses = [];
    confirmResponses = [];
    editorResponses = [];
    fetchCalls = [];
  });

  afterEach(async () => {
    _setCacheDir(undefined);
    process.env = { ...originalEnv };
    globalThis.fetch = originalFetch;
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      writable: true,
      configurable: true,
    });
    errorSpy.mockRestore();
    logSpy.mockRestore();
    exitSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("shows help and returns in agent mode", async () => {
    const deps = buildDeps({ isHuman: false });

    await apiInteractive(deps, {});
    expect(deps.log.info).toHaveBeenCalledWith(
      expect.stringContaining("Interactive mode requires a TTY"),
    );
  });

  test("completes full flow for GET endpoint (no body, no params)", async () => {
    const deps = buildDeps({ isHuman: true });

    // Step 1: select tag "Users"
    selectResponses.push("Users");
    // Step 2: select endpoint GET /users
    selectResponses.push({
      method: "GET",
      path: "/users",
      summary: "List all users",
      tag: "Users",
      operationId: "GetUserList",
      pathParams: [],
      hasRequestBody: false,
    });
    // Step 5: confirm execution
    confirmResponses.push(true);

    await apiInteractive(deps, {});

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toContain("/v1/users");
    expect(fetchCalls[0]!.method).toBe("GET");
  });

  test("prompts for path parameters", async () => {
    const deps = buildDeps({ isHuman: true });

    selectResponses.push("Users");
    selectResponses.push({
      method: "GET",
      path: "/users/{user_id}",
      summary: "Retrieve a user",
      tag: "Users",
      operationId: "GetUser",
      pathParams: [{ name: "user_id", description: "The ID of the user" }],
      hasRequestBody: false,
    });
    inputResponses.push("user_abc123");
    confirmResponses.push(true);

    await apiInteractive(deps, {});

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toContain("/v1/users/user_abc123");
  });

  test("aborts when user declines confirmation", async () => {
    const deps = buildDeps({ isHuman: true });

    selectResponses.push("Users");
    selectResponses.push({
      method: "GET",
      path: "/users",
      summary: "List all users",
      tag: "Users",
      operationId: "GetUserList",
      pathParams: [],
      hasRequestBody: false,
    });
    confirmResponses.push(false); // decline

    await expect(apiInteractive(deps, {})).rejects.toThrow("User aborted");

    expect(fetchCalls.length).toBe(0);
  });
});
