import { test, expect, describe, afterEach, beforeEach, spyOn } from "bun:test";
import { rm } from "node:fs/promises";
import { stubFetch } from "../../test/stubs.ts";
import { CLERK_CACHE_DIR } from "../../lib/constants.ts";

const SAMPLE_YAML = `openapi: 3.0.3
info:
  title: Clerk Backend API
  version: "2025-11-10"
paths: {}
`;

const SPEC_WITH_PATHS = `openapi: 3.0.3
info:
  title: Clerk Backend API
  version: "2025-11-10"
paths:
  /v1/users:
    get:
      summary: List all users
      operationId: ListUsers
  /v1/users/{user_id}:
    get:
      summary: Get a user
      operationId: GetUser
  /v1/organizations:
    get:
      summary: List organizations
      operationId: ListOrganizations
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
        first_name:
          type: string
    Organization:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
`;

const SPEC_WITH_REFS = `openapi: 3.0.3
info:
  title: Test API
  version: "1.0.0"
paths:
  /v1/users:
    get:
      summary: List users
      responses:
        "200":
          content:
            application/json:
              schema:
                type: array
                items:
                  $ref: "#/components/schemas/User"
components:
  schemas:
    User:
      type: object
      properties:
        id:
          type: string
        org:
          $ref: "#/components/schemas/Organization"
    Organization:
      type: object
      properties:
        id:
          type: string
        name:
          type: string
`;

const SPEC_WITH_CIRCULAR_REFS = `openapi: 3.0.3
info:
  title: Test API
  version: "1.0.0"
paths: {}
components:
  schemas:
    Node:
      type: object
      properties:
        value:
          type: string
        child:
          $ref: "#/components/schemas/Node"
`;

// Save original fetch so we can restore it
const originalFetch = globalThis.fetch;

const { schema, resolveAllRefs } = await import("./index.ts");

describe("schema", () => {
  let consoleSpy: ReturnType<typeof spyOn>;
  let consoleErrorSpy: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    consoleSpy = spyOn(console, "log").mockImplementation(() => {});
    consoleErrorSpy = spyOn(console, "error").mockImplementation(() => {});
    // Clear cached specs so each test controls its own fetch
    await rm(CLERK_CACHE_DIR, { recursive: true, force: true });
  });

  afterEach(() => {
    consoleSpy?.mockRestore();
    consoleErrorSpy?.mockRestore();
    globalThis.fetch = originalFetch;
  });

  // ── No argument: list APIs ──────────────────────────────────────────────

  test("lists available APIs when no argument given", async () => {
    await schema(undefined, undefined, {});

    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("backend");
    expect(output).toContain("frontend");
    expect(output).toContain("platform");
    expect(output).toContain("webhooks");
    expect(output).toContain("Usage:");
  });

  test("shows aliases in the API listing", async () => {
    await schema(undefined, undefined, {});

    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("bapi");
    expect(output).toContain("fapi");
  });

  // ── Alias resolution ───────────────────────────────────────────────────

  test("resolves 'bapi' alias to 'backend'", async () => {
    stubFetch(async (url) => {
      expect(String(url)).toContain("/bapi/");
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("bapi", undefined, {});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("openapi: 3.0.3"));
  });

  test("resolves 'fapi' alias to 'frontend'", async () => {
    stubFetch(async (url) => {
      expect(String(url)).toContain("/fapi/");
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("fapi", undefined, {});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("openapi: 3.0.3"));
  });

  test("accepts public name 'backend' directly", async () => {
    stubFetch(async (url) => {
      expect(String(url)).toContain("/bapi/");
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("backend", undefined, {});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("openapi: 3.0.3"));
  });

  // ── Unknown API ────────────────────────────────────────────────────────

  test("throws on unknown API name", async () => {
    await expect(schema("nonexistent", undefined, {})).rejects.toThrow(/Unknown API "nonexistent"/);
  });

  // ── Version selection ──────────────────────────────────────────────────

  test("fetches the latest version by default", async () => {
    let requestedUrl = "";
    stubFetch(async (url) => {
      requestedUrl = String(url);
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("backend", undefined, {});
    expect(requestedUrl).toContain("/2025-11-10.yml");
  });

  test("fetches a specific version when --spec-version is set", async () => {
    let requestedUrl = "";
    stubFetch(async (url) => {
      requestedUrl = String(url);
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("backend", undefined, { specVersion: "2024-10-01" });
    expect(requestedUrl).toContain("/2024-10-01.yml");
  });

  test("throws on unknown version", async () => {
    await expect(schema("backend", undefined, { specVersion: "1999-01-01" })).rejects.toThrow(
      /Unknown version "1999-01-01"/,
    );
  });

  // ── Format ─────────────────────────────────────────────────────────────

  test("outputs YAML by default", async () => {
    stubFetch(async () => new Response(SAMPLE_YAML, { status: 200 }));

    await schema("backend", undefined, {});
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain("openapi: 3.0.3");
  });

  test("outputs JSON when format is json", async () => {
    stubFetch(async () => new Response(SAMPLE_YAML, { status: 200 }));

    await schema("backend", undefined, { format: "json" });
    const output = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.openapi).toBe("3.0.3");
  });

  test("throws on invalid format", async () => {
    await expect(schema("backend", undefined, { format: "xml" })).rejects.toThrow(
      /Invalid format "xml"/,
    );
  });

  // ── Output to file ────────────────────────────────────────────────────

  test("writes to file when --output is set", async () => {
    stubFetch(async () => new Response(SAMPLE_YAML, { status: 200 }));

    const tmpFile = `/tmp/clerk-schema-test-${Date.now()}.yml`;
    await schema("backend", undefined, { output: tmpFile });

    expect(consoleSpy).not.toHaveBeenCalled();
    expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining(tmpFile));

    const written = await Bun.file(tmpFile).text();
    expect(written).toContain("openapi: 3.0.3");

    // Cleanup
    const { unlink } = await import("node:fs/promises");
    await unlink(tmpFile);
  });

  // ── Network errors ────────────────────────────────────────────────────

  test("throws CliError when fetch fails", async () => {
    stubFetch(async () => new Response("Not Found", { status: 404 }));

    await expect(schema("backend", undefined, {})).rejects.toThrow(/Unable to fetch OpenAPI spec/);
  });

  test("throws CliError on network error", async () => {
    stubFetch(async () => {
      throw new Error("Network unreachable");
    });

    await expect(schema("backend", undefined, {})).rejects.toThrow(/Unable to fetch OpenAPI spec/);
  });

  // ── Path-based introspection ──────────────────────────────────────────

  test("looks up a path with /v1 prefix", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await schema("backend", "/users", { format: "json" });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.paths["/v1/users"]).toBeDefined();
    expect(output.paths["/v1/users"].get.summary).toBe("List all users");
  });

  test("looks up a path by exact match", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await schema("backend", "/v1/organizations", { format: "json" });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.paths["/v1/organizations"]).toBeDefined();
  });

  test("looks up a parameterized path", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await schema("backend", "/v1/users/{user_id}", { format: "json" });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.paths["/v1/users/{user_id}"]).toBeDefined();
  });

  test("throws with suggestions for unknown path", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await expect(schema("backend", "/user", {})).rejects.toThrow(/No path "\/user" found/);
  });

  test("suggests similar paths when path not found", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await expect(schema("backend", "/user", {})).rejects.toThrow(/users/);
  });

  // ── Type lookup ────────────────────────────────────────────────────────

  test("looks up a schema type by exact name", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await schema("backend", "User", { format: "json" });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.components.schemas.User).toBeDefined();
    expect(output.components.schemas.User.type).toBe("object");
  });

  test("looks up a schema type case-insensitively", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await schema("backend", "user", { format: "json" });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    expect(output.components.schemas.User).toBeDefined();
  });

  test("throws with suggestions for unknown type", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await expect(schema("backend", "Usr", {})).rejects.toThrow(/No schema type "Usr" found/);
  });

  // ── --resolve-refs ─────────────────────────────────────────────────────

  test("inlines $ref references with --resolve-refs", async () => {
    stubFetch(async () => new Response(SPEC_WITH_REFS, { status: 200 }));

    await schema("backend", "User", { format: "json", resolveRefs: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    const user = output.components.schemas.User;
    // The org property should be inlined, not a $ref
    expect(user.properties.org.type).toBe("object");
    expect(user.properties.org.properties.name.type).toBe("string");
  });

  test("inlines $ref references in path responses", async () => {
    stubFetch(async () => new Response(SPEC_WITH_REFS, { status: 200 }));

    await schema("backend", "/users", { format: "json", resolveRefs: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    const items =
      output.paths["/v1/users"].get.responses["200"].content["application/json"].schema.items;
    // Should be inlined User, not a $ref
    expect(items.type).toBe("object");
    expect(items.properties.id.type).toBe("string");
  });

  test("handles circular $ref without infinite loop", async () => {
    stubFetch(async () => new Response(SPEC_WITH_CIRCULAR_REFS, { status: 200 }));

    await schema("backend", "Node", { format: "json", resolveRefs: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    const node = output.components.schemas.Node;
    // First level should be resolved
    expect(node.properties.value.type).toBe("string");
    // First-level child is inlined (resolved)
    expect(node.properties.child.type).toBe("object");
    // The nested circular child should be marked, not infinitely expanded
    expect(node.properties.child.properties.child.$ref).toBe("#/components/schemas/Node");
    expect(node.properties.child.properties.child.$comment).toBe("circular reference");
  });

  test("resolves full spec refs when no path given", async () => {
    stubFetch(async () => new Response(SPEC_WITH_REFS, { status: 200 }));

    await schema("backend", undefined, { format: "json", resolveRefs: true });
    const output = JSON.parse(consoleSpy.mock.calls[0][0]);
    // The User's org property should be inlined
    expect(output.components.schemas.User.properties.org.type).toBe("object");
  });

  // ── Path output in YAML format ─────────────────────────────────────────

  test("outputs path subset as YAML", async () => {
    stubFetch(async () => new Response(SPEC_WITH_PATHS, { status: 200 }));

    await schema("backend", "/users", {});
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain("List all users");
    expect(output).toContain("/v1/users");
  });
});

// ── resolveAllRefs unit tests ────────────────────────────────────────────────

describe("resolveAllRefs", () => {
  test("resolves a simple $ref", () => {
    const spec = {
      components: { schemas: { Foo: { type: "object" } } },
      result: { $ref: "#/components/schemas/Foo" },
    };
    const resolved = resolveAllRefs(spec, spec) as Record<string, unknown>;
    expect((resolved.result as Record<string, unknown>).type).toBe("object");
  });

  test("resolves nested $refs", () => {
    const spec = {
      components: {
        schemas: {
          Inner: { type: "string" },
          Outer: { prop: { $ref: "#/components/schemas/Inner" } },
        },
      },
    };
    const resolved = resolveAllRefs(spec, spec) as any;
    expect(resolved.components.schemas.Outer.prop.type).toBe("string");
  });

  test("handles circular refs safely", () => {
    const spec = {
      components: {
        schemas: {
          Self: { child: { $ref: "#/components/schemas/Self" } },
        },
      },
    };
    const resolved = resolveAllRefs(spec, spec) as any;
    // First level is inlined; the nested circular ref is marked
    expect(resolved.components.schemas.Self.child.child.$comment).toBe("circular reference");
  });

  test("preserves sibling properties next to $ref", () => {
    const spec = {
      components: { schemas: { Base: { type: "object" } } },
      result: { $ref: "#/components/schemas/Base", description: "override" },
    };
    const resolved = resolveAllRefs(spec, spec) as any;
    expect(resolved.result.type).toBe("object");
    expect(resolved.result.description).toBe("override");
  });

  test("returns primitives unchanged", () => {
    expect(resolveAllRefs("hello", {})).toBe("hello");
    expect(resolveAllRefs(42, {})).toBe(42);
    expect(resolveAllRefs(null, {})).toBe(null);
    expect(resolveAllRefs(true, {})).toBe(true);
  });

  test("processes arrays", () => {
    const spec = {
      components: { schemas: { Item: { type: "number" } } },
      items: [{ $ref: "#/components/schemas/Item" }, { value: 1 }],
    };
    const resolved = resolveAllRefs(spec, spec) as any;
    expect(resolved.items[0].type).toBe("number");
    expect(resolved.items[1].value).toBe(1);
  });

  test("leaves external $refs untouched", () => {
    const spec = { result: { $ref: "https://example.com/schema.json" } };
    const resolved = resolveAllRefs(spec, spec) as any;
    expect(resolved.result.$ref).toBe("https://example.com/schema.json");
  });

  test("leaves unresolvable internal $refs as-is", () => {
    const spec = { result: { $ref: "#/does/not/exist" } };
    const resolved = resolveAllRefs(spec, spec) as any;
    expect(resolved.result.$ref).toBe("#/does/not/exist");
  });
});
