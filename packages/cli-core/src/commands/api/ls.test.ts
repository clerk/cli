import { test, expect, describe, beforeEach, afterEach, mock } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseSpec, _setCacheDir } from "./catalog.ts";
import { stubFetch } from "../../test/lib/stubs.ts";
import { apiLs } from "./ls.ts";
import { testRoot } from "../../test/lib/test-root.ts";

function joinCalls(fn: unknown): string[] {
  return ((fn as ReturnType<typeof mock>).mock.calls as unknown[][]).map((c) => String(c[0] ?? ""));
}

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
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-ls-test-"));
    _setCacheDir(tempDir);

    // Pre-populate fresh cache so no fetch needed
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now();
    await Bun.write(join(tempDir, "bapi-catalog.json"), JSON.stringify(cached));

    stubFetch(async () => {
      throw new Error("Should not fetch");
    });
  });

  afterEach(async () => {
    _setCacheDir(undefined);
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("prints all endpoints in table format", async () => {
    const deps = testRoot();
    await apiLs(deps, undefined, {});

    const dataCalls = joinCalls(deps.log.data);
    expect(dataCalls.length).toBe(4);
    expect(dataCalls[0]).toContain("GET");
    expect(dataCalls[0]).toContain("/users");
    expect(dataCalls[0]).toContain("List all users");

    const infoCalls = joinCalls(deps.log.info);
    expect(infoCalls.some((m) => m.includes("4 endpoints"))).toBe(true);
  });

  test("filters endpoints by keyword", async () => {
    const deps = testRoot();
    await apiLs(deps, "organizations", {});

    const dataCalls = joinCalls(deps.log.data);
    expect(dataCalls.length).toBe(1);
    expect(dataCalls[0]).toContain("/organizations");

    const infoCalls = joinCalls(deps.log.info);
    expect(infoCalls.some((m) => m.includes('1 endpoint matching "organizations"'))).toBe(true);
  });

  test("shows message when no matches", async () => {
    const deps = testRoot();
    await apiLs(deps, "zzzzz", {});

    expect(deps.log.data).not.toHaveBeenCalled();
    const infoCalls = joinCalls(deps.log.info);
    expect(infoCalls.some((m) => m.includes('No endpoints matching "zzzzz"'))).toBe(true);
  });

  test("uses platform catalog when --platform set", async () => {
    // Pre-populate platform cache
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now();
    await Bun.write(join(tempDir, "plapi-catalog.json"), JSON.stringify(cached));

    const deps = testRoot();
    await apiLs(deps, undefined, { platform: true });
    expect(deps.log.data).toHaveBeenCalled();
  });
});
