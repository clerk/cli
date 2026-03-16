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

// Save original fetch so we can restore it
const originalFetch = globalThis.fetch;

const { schema } = await import("./index.ts");

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
    await schema(undefined, {});

    const output = consoleSpy.mock.calls.map((c: unknown[]) => c[0]).join("\n");
    expect(output).toContain("backend");
    expect(output).toContain("frontend");
    expect(output).toContain("platform");
    expect(output).toContain("webhooks");
    expect(output).toContain("Usage:");
  });

  test("shows aliases in the API listing", async () => {
    await schema(undefined, {});

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

    await schema("bapi", {});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("openapi: 3.0.3"));
  });

  test("resolves 'fapi' alias to 'frontend'", async () => {
    stubFetch(async (url) => {
      expect(String(url)).toContain("/fapi/");
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("fapi", {});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("openapi: 3.0.3"));
  });

  test("accepts public name 'backend' directly", async () => {
    stubFetch(async (url) => {
      expect(String(url)).toContain("/bapi/");
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("backend", {});
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("openapi: 3.0.3"));
  });

  // ── Unknown API ────────────────────────────────────────────────────────

  test("throws on unknown API name", async () => {
    await expect(schema("nonexistent", {})).rejects.toThrow(/Unknown API "nonexistent"/);
  });

  // ── Version selection ──────────────────────────────────────────────────

  test("fetches the latest version by default", async () => {
    let requestedUrl = "";
    stubFetch(async (url) => {
      requestedUrl = String(url);
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("backend", {});
    expect(requestedUrl).toContain("/2025-11-10.yml");
  });

  test("fetches a specific version when --spec-version is set", async () => {
    let requestedUrl = "";
    stubFetch(async (url) => {
      requestedUrl = String(url);
      return new Response(SAMPLE_YAML, { status: 200 });
    });

    await schema("backend", { specVersion: "2024-10-01" });
    expect(requestedUrl).toContain("/2024-10-01.yml");
  });

  test("throws on unknown version", async () => {
    await expect(schema("backend", { specVersion: "1999-01-01" })).rejects.toThrow(
      /Unknown version "1999-01-01"/,
    );
  });

  // ── Format ─────────────────────────────────────────────────────────────

  test("outputs YAML by default", async () => {
    stubFetch(async () => new Response(SAMPLE_YAML, { status: 200 }));

    await schema("backend", {});
    const output = consoleSpy.mock.calls[0][0];
    expect(output).toContain("openapi: 3.0.3");
  });

  test("outputs JSON when format is json", async () => {
    stubFetch(async () => new Response(SAMPLE_YAML, { status: 200 }));

    await schema("backend", { format: "json" });
    const output = consoleSpy.mock.calls[0][0];
    const parsed = JSON.parse(output);
    expect(parsed.openapi).toBe("3.0.3");
  });

  test("throws on invalid format", async () => {
    await expect(schema("backend", { format: "xml" })).rejects.toThrow(/Invalid format "xml"/);
  });

  // ── Output to file ────────────────────────────────────────────────────

  test("writes to file when --output is set", async () => {
    stubFetch(async () => new Response(SAMPLE_YAML, { status: 200 }));

    const tmpFile = `/tmp/clerk-schema-test-${Date.now()}.yml`;
    await schema("backend", { output: tmpFile });

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

    await expect(schema("backend", {})).rejects.toThrow(/Unable to fetch OpenAPI spec/);
  });

  test("throws CliError on network error", async () => {
    stubFetch(async () => {
      throw new Error("Network unreachable");
    });

    await expect(schema("backend", {})).rejects.toThrow(/Unable to fetch OpenAPI spec/);
  });
});
