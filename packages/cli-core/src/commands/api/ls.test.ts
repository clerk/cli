import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSpec, _setCacheDir } from "./catalog.ts";
import { captureLog, stubFetch } from "../../test/lib/stubs.ts";
import { apiLs } from "./ls.ts";

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
  /organizations:
    get:
      tags: [Organizations]
      summary: List all organizations
      operationId: ListOrganizations
`;

describe("apiLs", () => {
  let tempDir: string;
  let logSpy: ReturnType<typeof spyOn>;
  let errorSpy: ReturnType<typeof spyOn>;
  let captured: ReturnType<typeof captureLog>;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-ls-test-"));
    _setCacheDir(tempDir);

    // Pre-populate fresh cache so no fetch needed
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now();
    await Bun.write(join(tempDir, "bapi-catalog.json"), JSON.stringify(cached));

    logSpy = spyOn(console, "log").mockImplementation(() => {});
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
    captured = captureLog();
    stubFetch(async () => {
      throw new Error("Should not fetch");
    });
  });

  afterEach(async () => {
    captured.teardown();
    _setCacheDir(undefined);
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  function runApiLs(filter: string | undefined, options: Parameters<typeof apiLs>[1]) {
    return captured.run(() => apiLs(filter, options));
  }

  test("prints all endpoints in table format", async () => {
    await runApiLs(undefined, {});

    // Check that output contains method, path, and summary
    expect(captured.out).toContain("GET");
    expect(captured.out).toContain("/users");
    expect(captured.out).toContain("List all users");

    // Footer
    expect(captured.err).toContain("4 endpoints");
  });

  test("filters endpoints by keyword", async () => {
    await runApiLs("organizations", {});

    expect(captured.out).toContain("/organizations");

    expect(captured.err).toContain('1 endpoint matching "organizations"');
  });

  test("shows message when no matches", async () => {
    await runApiLs("zzzzz", {});

    expect(captured.out).toBe("");
    expect(captured.err).toContain('No endpoints matching "zzzzz"');
  });

  test("uses platform catalog when --platform set", async () => {
    // Pre-populate platform cache
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now();
    await Bun.write(join(tempDir, "plapi-catalog.json"), JSON.stringify(cached));

    await runApiLs(undefined, { platform: true });
    expect(captured.out).not.toBe("");
  });
});
