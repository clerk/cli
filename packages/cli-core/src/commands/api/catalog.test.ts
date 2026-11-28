import { test, expect, describe, beforeEach, afterEach, spyOn } from "bun:test";
import { useCaptureLog, stubFetch } from "../../test/lib/stubs.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  parseSpec,
  loadCatalog,
  filterEndpoints,
  endpointsByTag,
  flattenSchema,
  formatType,
  resolveRef,
  _setCacheDir,
} from "./catalog.ts";

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

  test("lists the item fields of a body typed as a nullable array", () => {
    const catalog = parseSpec(`
openapi: "3.1.0"
paths:
  /items:
    post:
      requestBody:
        content:
          application/json:
            schema:
              type: [array, "null"]
              items:
                type: object
                required: [name]
                properties:
                  name: { type: string, description: The name }
`);
    expect(catalog.endpoints[0]!.requestBody).toEqual({
      contentType: "application/json",
      required: false,
      type: "array of object",
      fields: [{ name: "name", type: "string", required: true, description: "The name" }],
    });
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
  let errorSpy: ReturnType<typeof spyOn>;
  const captured = useCaptureLog();

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "clerk-catalog-test-"));
    _setCacheDir(tempDir);
    errorSpy = spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(async () => {
    _setCacheDir(undefined);
    globalThis.fetch = originalFetch;
    errorSpy.mockRestore();
    await rm(tempDir, { recursive: true, force: true });
  });

  function runLoadCatalog(options?: Parameters<typeof loadCatalog>[0]) {
    return loadCatalog(options);
  }

  test("fetches and caches on first load", async () => {
    let fetchCalled = false;
    stubFetch(async () => {
      fetchCalled = true;
      return new Response(MINIMAL_SPEC, { status: 200 });
    });

    const catalog = await runLoadCatalog();
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

    const catalog = await runLoadCatalog();
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

    await runLoadCatalog();
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

    const catalog = await runLoadCatalog();
    expect(catalog.endpoints.length).toBe(6);
    expect(captured.err).toContain("Unable to refresh");
  });

  test("errors when offline with no cache", async () => {
    stubFetch(async () => {
      throw new Error("Network error");
    });

    await expect(runLoadCatalog()).rejects.toThrow("Unable to fetch API catalog");
  });

  test("uses platform URL when platform flag set", async () => {
    let capturedUrl = "";
    stubFetch(async (input) => {
      capturedUrl = input.toString();
      return new Response(MINIMAL_SPEC, { status: 200 });
    });

    await runLoadCatalog({ platform: true });
    expect(capturedUrl).toContain("platform");

    // Cache uses platform filename
    const cacheFile = Bun.file(join(tempDir, "plapi-catalog.json"));
    expect(await cacheFile.exists()).toBe(true);
  });
});

const SPEC = {
  components: {
    schemas: {
      Name: { type: "string", description: "A name" },
      Alias: { $ref: "#/components/schemas/Name" },
      Loop: { $ref: "#/components/schemas/Loop" },
      Base: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
      },
      Mixin: {
        properties: { tag: { type: "string" } },
        required: ["tag"],
      },
      Derived: {
        allOf: [{ $ref: "#/components/schemas/Base" }, { $ref: "#/components/schemas/Mixin" }],
        properties: { extra: { type: "integer" } },
        description: "Derived",
      },
    },
  },
};

describe("resolveRef", () => {
  test.each([
    {
      label: "a schema without $ref as is",
      schema: { type: "integer" },
      expected: { type: "integer" },
    },
    {
      label: "a local $ref",
      schema: { $ref: "#/components/schemas/Name" },
      expected: { type: "string", description: "A name" },
    },
    {
      label: "a chain of $refs",
      schema: { $ref: "#/components/schemas/Alias" },
      expected: { type: "string", description: "A name" },
    },
    {
      label: "a missing $ref target as empty",
      schema: { $ref: "#/components/schemas/Nope" },
      expected: {},
    },
    { label: "a non-object as empty", schema: "string", expected: {} },
    { label: "undefined as empty", schema: undefined, expected: {} },
    {
      label: "a self-referencing $ref by stopping",
      schema: { $ref: "#/components/schemas/Loop" },
      expected: { $ref: "#/components/schemas/Loop" },
    },
  ])("resolves $label", ({ schema, expected }) => {
    expect(resolveRef(SPEC, schema)).toEqual(expected);
  });
});

describe("flattenSchema", () => {
  test("merges allOf parts and the schema's own properties and required names", () => {
    const flat = flattenSchema(SPEC, { $ref: "#/components/schemas/Derived" });
    expect(Object.keys(flat.properties)).toEqual(["id", "tag", "extra"]);
    expect(flat.required).toEqual(["id", "tag"]);
    expect(flat.type).toBe("object");
    expect(flat.description).toBe("Derived");
  });

  test("combines a property several allOf parts define instead of replacing it", () => {
    const flat = flattenSchema(SPEC, {
      allOf: [
        { properties: { mode: { enum: ["api", "mcp"] } } },
        { properties: { mode: { type: "string", description: "The mode" } } },
      ],
    });
    expect(formatType(SPEC, flat.properties.mode)).toBe('"api" | "mcp"');
    expect(flattenSchema(SPEC, flat.properties.mode).description).toBe("The mode");
  });

  test.each([
    { label: "a schema without allOf", schema: { type: "string" }, expected: { type: "string" } },
    {
      label: "a $ref without allOf",
      schema: { $ref: "#/components/schemas/Base" },
      expected: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  ])("returns $label as resolved", ({ schema, expected }) => {
    expect(flattenSchema(SPEC, schema)).toEqual(expected);
  });
});

describe("formatType", () => {
  test.each(
    [
      { schema: { type: "string" }, expected: "string" },
      { schema: { type: "string", nullable: true }, expected: "string | null" },
      { schema: { type: ["string", "null"] }, expected: "string | null" },
      { schema: { type: ["string", "null"], nullable: true }, expected: "string | null" },
      { schema: { $ref: "#/components/schemas/Alias" }, expected: "string" },
      { schema: { enum: ["a", "b"] }, expected: '"a" | "b"' },
      { schema: { enum: ["a"], nullable: true }, expected: '"a" | null' },
      {
        schema: { oneOf: [{ type: "string" }, { type: "integer" }] },
        expected: "string | integer",
      },
      { schema: { anyOf: [{ type: "string" }, { type: "string" }] }, expected: "string" },
      { schema: { type: "array", items: { type: "string" } }, expected: "string[]" },
      {
        schema: { type: "array", items: { oneOf: [{ type: "string" }, { type: "integer" }] } },
        expected: "(string | integer)[]",
      },
      {
        schema: { type: "array", items: { type: "string" }, nullable: true },
        expected: "string[] | null",
      },
      {
        schema: { type: ["array", "null"], items: { type: "string" } },
        expected: "string[] | null",
      },
      {
        schema: { type: ["array", "null"], items: { enum: ["a", "b"] } },
        expected: '("a" | "b")[] | null',
      },
      { schema: { $ref: "#/components/schemas/Derived" }, expected: "object" },
      { schema: { properties: { a: { type: "string" } } }, expected: "object" },
      { schema: {}, expected: "any" },
    ].map((c) => ({ ...c, json: JSON.stringify(c.schema) })),
  )("formats $json as $expected", ({ schema, expected }) => {
    expect(formatType(SPEC, schema)).toBe(expected);
  });
});
