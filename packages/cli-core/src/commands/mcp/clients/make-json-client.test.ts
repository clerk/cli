import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import * as realOs from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

// cursorClient writes under home now; redirect homedir to the cwd tmpdir so the
// `join(cwd, ".cursor", ...)` reads below stay isolated. Mock before importing
// the client so paths.ts binds the redirected homedir.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));

const { cursorClient } = await import("./cursor.ts");

useCaptureLog();

const URL_A = "https://mcp.clerk.com/mcp";
const URL_B = "http://localhost:8787/mcp";

describe("make-json-client (via cursor)", () => {
  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-cursor-"));
    mockHome = cwd;
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function read(): Promise<{
    otherTopLevel?: string;
    mcpServers?: Record<string, { url: string }>;
  }> {
    const text = await readFile(join(cwd, ".cursor", "mcp.json"), "utf8");
    return JSON.parse(text);
  }

  describe("upsert", () => {
    test("creates the config file when it does not exist", async () => {
      const result = await cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false);
      expect(result.status).toBe("added");
      const written = await read();
      expect(written.mcpServers?.clerk).toEqual({ url: URL_A });
    });

    test("preserves unrelated keys in the file", async () => {
      const configPath = join(cwd, ".cursor", "mcp.json");
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ otherTopLevel: "keep", mcpServers: { other: { url: "http://x" } } }),
      );
      await cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false);
      const written = await read();
      expect(written.otherTopLevel).toBe("keep");
      expect(written.mcpServers?.other).toEqual({ url: "http://x" });
      expect(written.mcpServers?.clerk).toEqual({ url: URL_A });
    });

    test("returns unchanged when the URL already matches", async () => {
      await cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false);
      const result = await cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false);
      expect(result.status).toBe("unchanged");
    });

    test("skips when URL conflicts and force is false", async () => {
      await cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false);
      const result = await cursorClient.upsert({ name: "clerk", url: URL_B }, cwd, false);
      expect(result.status).toBe("skipped");
      // Narrow the discriminated union so `reason` is typed as present.
      if (result.status === "skipped") expect(result.reason).toContain("--force");
      const written = await read();
      expect(written.mcpServers?.clerk?.url).toBe(URL_A);
    });

    test("overwrites when URL conflicts and force is true", async () => {
      await cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false);
      const result = await cursorClient.upsert({ name: "clerk", url: URL_B }, cwd, true);
      expect(result.status).toBe("updated");
      const written = await read();
      expect(written.mcpServers?.clerk?.url).toBe(URL_B);
    });

    test("rejects a config whose top-level is not an object", async () => {
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(join(cwd, ".cursor", "mcp.json"), "[1,2,3]");
      await expect(cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false)).rejects.toThrow(
        /not a JSON object/,
      );
    });

    test("treats an inherited Object property name as absent (no false skip)", async () => {
      // `toString` lives on Object.prototype; a naive `servers[name]` lookup would
      // read back the inherited function and wrongly report an existing entry.
      const result = await cursorClient.upsert({ name: "toString", url: URL_A }, cwd, false);
      expect(result.status).toBe("added");
      const written = await read();
      expect(written.mcpServers?.["toString"]).toEqual({ url: URL_A });
    });
  });

  describe("remove", () => {
    test("removes a present entry", async () => {
      await cursorClient.upsert({ name: "clerk", url: URL_A }, cwd, false);
      const result = await cursorClient.remove("clerk", cwd);
      expect(result.removed).toBe(true);
      const written = await read();
      expect(written.mcpServers?.clerk).toBeUndefined();
    });

    test("is a no-op when the entry is absent", async () => {
      const result = await cursorClient.remove("clerk", cwd);
      expect(result.removed).toBe(false);
    });

    test("does not false-remove an inherited Object property name", async () => {
      // `"toString" in servers` is true via the prototype; the own-property guard
      // must report removed:false rather than rewriting the file.
      const result = await cursorClient.remove("toString", cwd);
      expect(result.removed).toBe(false);
    });
  });

  describe("list", () => {
    test("returns clerk-named and clerk-hosted entries, ignores others", async () => {
      const configPath = join(cwd, ".cursor", "mcp.json");
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({
          mcpServers: {
            clerk: { url: URL_A },
            "other-clerk": { url: "https://mcp.clerk.com/mcp" },
            unrelated: { url: "https://example.com/mcp" },
          },
        }),
      );
      const entries = await cursorClient.list(cwd);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["clerk", "other-clerk"]);
    });

    test("returns empty when no config file exists", async () => {
      const entries = await cursorClient.list(cwd);
      expect(entries).toEqual([]);
    });

    test("returns empty (does not throw) on malformed JSON", async () => {
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(join(cwd, ".cursor", "mcp.json"), "not json");
      const entries = await cursorClient.list(cwd);
      expect(entries).toEqual([]);
    });

    test("returns empty (does not throw) when the top-level key is not an object", async () => {
      // Valid JSON, wrong shape: `mcpServers` is an array. getServerMap throws
      // MCP_CLIENT_CONFIG_INVALID, which list() must swallow so one bad config
      // can't crash `mcp list` across the other clients.
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        join(cwd, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: ["not", "an", "object"] }),
      );
      const entries = await cursorClient.list(cwd);
      expect(entries).toEqual([]);
    });
  });
});
