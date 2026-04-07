import { test, expect, describe, beforeEach, afterEach } from "bun:test";
import { stubFetch } from "../../test/lib/stubs.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSpec,
  loadCatalog,
  filterEndpoints,
  endpointsByTag,
  _setCacheDir,
} from "./catalog.ts";
import { testRoot } from "../../test/lib/test-root.ts";

const deps = testRoot();

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
          required: true
    delete:
      tags: [Users]
      summary: Delete a user
      operationId: DeleteUser
      parameters:
        - name: user_id
          in: path
          required: true
  /organizations:
    get:
      tags: [Organizations]
      summary: List all organizations
      operationId: ListOrganizations
  /no-tag:
    get:
      summary: Endpoint without tags
      operationId: NoTag
`;

describe("parseSpec", () => {
  test("extracts endpoints from valid YAML", () => {
    const catalog = parseSpec(MINIMAL_SPEC);
    expect(catalog.endpoints.length).toBe(6);
    expect(catalog.endpoints[0]).toMatchObject({
      method: "GET",
      path: "/users",
      summary: "List all users",
      tag: "Users",
      operationId: "GetUserList",
    });
  });

  test("extracts path parameters", () => {
    const catalog = parseSpec(MINIMAL_SPEC);
    const getUser = catalog.endpoints.find((e) => e.operationId === "GetUser");
    expect(getUser!.pathParams).toEqual([{ name: "user_id", description: "The ID of the user" }]);
  });

  test("detects requestBody presence", () => {
    const catalog = parseSpec(MINIMAL_SPEC);
    const createUser = catalog.endpoints.find((e) => e.operationId === "CreateUser");
    expect(createUser!.hasRequestBody).toBe(true);

    const listUsers = catalog.endpoints.find((e) => e.operationId === "GetUserList");
    expect(listUsers!.hasRequestBody).toBe(false);
  });

  test("handles missing tags gracefully", () => {
    const catalog = parseSpec(MINIMAL_SPEC);
    const noTag = catalog.endpoints.find((e) => e.operationId === "NoTag");
    expect(noTag!.tag).toBe("Other");
  });

  test("produces sorted unique tags", () => {
    const catalog = parseSpec(MINIMAL_SPEC);
    expect(catalog.tags).toEqual(["Organizations", "Other", "Users"]);
  });

  test("sets fetchedAt timestamp", () => {
    const before = Date.now();
    const catalog = parseSpec(MINIMAL_SPEC);
    expect(catalog.fetchedAt).toBeGreaterThanOrEqual(before);
    expect(catalog.fetchedAt).toBeLessThanOrEqual(Date.now());
  });

  test("handles path-level parameters", () => {
    const spec = `
openapi: "3.0.0"
info:
  title: Test
  version: "1.0"
paths:
  /items/{item_id}:
    parameters:
      - name: item_id
        in: path
        description: Item ID
    get:
      tags: [Items]
      summary: Get item
      operationId: GetItem
`;
    const catalog = parseSpec(spec);
    const getItem = catalog.endpoints.find((e) => e.operationId === "GetItem");
    expect(getItem!.pathParams).toEqual([{ name: "item_id", description: "Item ID" }]);
  });
});

describe("filterEndpoints", () => {
  const catalog = parseSpec(MINIMAL_SPEC);

  test("returns all endpoints when no keyword", () => {
    expect(filterEndpoints(catalog)).toEqual(catalog.endpoints);
    expect(filterEndpoints(catalog, undefined)).toEqual(catalog.endpoints);
  });

  test("filters by path", () => {
    const results = filterEndpoints(catalog, "user");
    expect(results.length).toBe(4);
    expect(results.every((e) => e.path.includes("user"))).toBe(true);
  });

  test("filters by summary", () => {
    const results = filterEndpoints(catalog, "retrieve");
    expect(results.length).toBe(1);
    expect(results[0]!.operationId).toBe("GetUser");
  });

  test("filters by tag", () => {
    const results = filterEndpoints(catalog, "organizations");
    expect(results.length).toBe(1);
    expect(results[0]!.tag).toBe("Organizations");
  });

  test("is case-insensitive", () => {
    const results = filterEndpoints(catalog, "USER");
    expect(results.length).toBe(4);
  });

  test("returns empty array when no matches", () => {
    expect(filterEndpoints(catalog, "zzzzz")).toEqual([]);
  });
});

describe("endpointsByTag", () => {
  test("groups endpoints correctly", () => {
    const catalog = parseSpec(MINIMAL_SPEC);
    const grouped = endpointsByTag(catalog);
    expect(grouped.get("Users")!.length).toBe(4);
    expect(grouped.get("Organizations")!.length).toBe(1);
    expect(grouped.get("Other")!.length).toBe(1);
  });
});

describe("loadCatalog", () => {
  const originalFetch = globalThis.fetch;
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-catalog-test-"));
    _setCacheDir(tempDir);
  });

  afterEach(async () => {
    _setCacheDir(undefined);
    globalThis.fetch = originalFetch;
    await rm(tempDir, { recursive: true, force: true });
  });

  test("fetches and caches on first load", async () => {
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response(MINIMAL_SPEC, { status: 200 });
    });

    const catalog = await loadCatalog(deps);
    expect(fetchCalled).toBe(true);
    expect(catalog.endpoints.length).toBe(6);

    // Verify cache was written
    const cacheFile = Bun.file(join(tempDir, "bapi-catalog.json"));
    expect(await cacheFile.exists()).toBe(true);
  });

  test("uses cache when fresh", async () => {
    // Pre-populate cache
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now(); // fresh
    await Bun.write(join(tempDir, "bapi-catalog.json"), JSON.stringify(cached));

    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response(MINIMAL_SPEC, { status: 200 });
    });

    const catalog = await loadCatalog(deps);
    expect(fetchCalled).toBe(false);
    expect(catalog.endpoints.length).toBe(6);
  });

  test("re-fetches when cache is expired", async () => {
    // Pre-populate with expired cache
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now() - 25 * 60 * 60 * 1000; // 25 hours ago
    await Bun.write(join(tempDir, "bapi-catalog.json"), JSON.stringify(cached));

    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response(MINIMAL_SPEC, { status: 200 });
    });

    await loadCatalog(deps);
    expect(fetchCalled).toBe(true);
  });

  test("returns stale cache on network failure", async () => {
    // Pre-populate with expired cache
    const cached = parseSpec(MINIMAL_SPEC);
    cached.fetchedAt = Date.now() - 25 * 60 * 60 * 1000;
    await Bun.write(join(tempDir, "bapi-catalog.json"), JSON.stringify(cached));

    stubFetch(async () => {
      throw new Error("Network error");
    });

    const staleDeps = testRoot();
    const catalog = await loadCatalog(staleDeps);
    expect(catalog.endpoints.length).toBe(6);
    expect(staleDeps.log.warn).toHaveBeenCalledWith(expect.stringContaining("Unable to refresh"));
  });

  test("errors when offline with no cache", async () => {
    stubFetch(async () => {
      throw new Error("Network error");
    });

    await expect(loadCatalog(deps)).rejects.toThrow("Unable to fetch API catalog");
  });

  test("uses platform URL when platform flag set", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = input.toString();
      return new Response(MINIMAL_SPEC, { status: 200 });
    });

    await loadCatalog(deps, { platform: true });
    expect(capturedUrl).toContain("platform");

    // Cache uses platform filename
    const cacheFile = Bun.file(join(tempDir, "plapi-catalog.json"));
    expect(await cacheFile.exists()).toBe(true);
  });
});
