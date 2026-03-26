import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSpec, _setCacheDir } from "./catalog.ts";
import { stubFetch } from "../../test/lib/stubs.ts";
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
    stubFetch(async () => {
      throw new Error("Should not fetch");
    });
  });

  afterEach(async () => {
    _setCacheDir(undefined);
    globalThis.fetch = originalFetch;
    logSpy.mockRestore();
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  test("prints all endpoints in table format", async () => {
    await apiLs(undefined, {});

    expect(logSpy).toHaveBeenCalledTimes(4);
    // Check that each line contains method, path, and summary
    const firstCall = logSpy.mock.calls[0][0] as string;
    expect(firstCall).toContain("GET");
    expect(firstCall).toContain("/users");
    expect(firstCall).toContain("List all users");

    // Footer
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("4 endpoints"));
  });

  test("filters endpoints by keyword", async () => {
    await apiLs("organizations", {});

    expect(logSpy).toHaveBeenCalledTimes(1);
    const line = logSpy.mock.calls[0][0] as string;
    expect(line).toContain("/organizations");

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('1 endpoint matching "organizations"'),
    );
  });

  test("shows message when no matches", async () => {
    await apiLs("zzzzz", {});

    expect(logSpy).not.toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('No endpoints matching "zzzzz"'));
  });

  test("uses platform catalog when --platform set", async () => {
    // Pre-populate platform cache
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now();
    await Bun.write(join(tempDir, "plapi-catalog.json"), JSON.stringify(cached));

    await apiLs(undefined, { platform: true });
    expect(logSpy).toHaveBeenCalled();
  });
});
