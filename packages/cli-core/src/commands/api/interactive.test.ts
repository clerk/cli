import { test, expect, describe, beforeEach, afterEach, spyOn, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { useCaptureLog, promptsStubs, listageStubs, stubFetch } from "../../test/lib/stubs.ts";

let _mode = "human";
mock.module("../../mode.ts", () => ({
  setMode: (m: string) => {
    _mode = m;
  },
  getMode: () => _mode,
  isAgent: () => _mode === "agent",
  isHuman: () => _mode !== "agent",
}));

const { parseSpec, _setCacheDir } = (await import("./catalog.ts")) as any;
const { setMode } = (await import("../../mode.ts")) as any;

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

// Track fetch calls made by the real api handler
let fetchCalls: { url: string; method: string }[] = [];

mock.module("../../lib/prompts.ts", () => ({
  confirm: async () => confirmResponses.shift(),
  text: async () => inputResponses.shift(),
  editor: async () => inputResponses.shift(),
}));

mock.module("../../lib/listage.ts", () => ({
  ...listageStubs,
  select: async () => selectResponses.shift(),
}));

describe("apiInteractive", () => {
  let tempDir: string;
  let errorSpy: ReturnType<typeof spyOn>;
  let logSpy: ReturnType<typeof spyOn>;
  let exitSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();
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

  async function runApiInteractive(options: Record<string, unknown> = {}) {
    const { apiInteractive } = await import("./interactive.ts");
    return apiInteractive(options);
  }

  test("shows help and returns in agent mode", async () => {
    setMode("agent");
    await runApiInteractive({});
    expect(captured.err).toContain("Interactive mode requires a TTY");
    setMode("human");
  });

  test("completes full flow for GET endpoint (no body, no params)", async () => {
    setMode("human");
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

    await runApiInteractive({});

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toContain("/v1/users");
    expect(fetchCalls[0]!.method).toBe("GET");
  });

  test("prompts for path parameters", async () => {
    setMode("human");
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

    await runApiInteractive({});

    expect(fetchCalls.length).toBe(1);
    expect(fetchCalls[0]!.url).toContain("/v1/users/user_abc123");
  });

  test("aborts when user declines confirmation", async () => {
    setMode("human");
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

    await expect(runApiInteractive({})).rejects.toThrow("User aborted");

    expect(fetchCalls.length).toBe(0);
  });
});
