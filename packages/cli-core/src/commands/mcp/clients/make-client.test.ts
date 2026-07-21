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
const { makeJsonClient, makeReadOnlyJsonClient } = await import("./make-client.ts");

useCaptureLog();

// The desired entry shape written by the current CLI — no URL in args; the
// bridge resolves its target at runtime via CLERK_MCP_URL or the env profile.
const CURRENT_SHAPE = { command: "clerk", args: ["mcp", "run"] };

// A foreign server entry that should be treated as a conflict.
const FOREIGN_URL = "https://other.example.com/mcp";
const FOREIGN_SHAPE = { url: FOREIGN_URL };

// A Clerk URL — matches what getMcpUrl() returns by default.
const CLERK_URL = "https://mcp.clerk.com/mcp";

describe("make-client (via cursor)", () => {
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
    mcpServers?: Record<string, { command?: string; args?: string[]; url?: string }>;
  }> {
    const text = await readFile(join(cwd, ".cursor", "mcp.json"), "utf8");
    return JSON.parse(text);
  }

  describe("upsert", () => {
    test("creates the config file when it does not exist", async () => {
      const result = await cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd);
      expect(result.status).toBe("installed");
      const written = await read();
      expect(written.mcpServers?.clerk).toEqual(CURRENT_SHAPE);
    });

    test("preserves unrelated keys in the file", async () => {
      const configPath = join(cwd, ".cursor", "mcp.json");
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        configPath,
        JSON.stringify({ otherTopLevel: "keep", mcpServers: { other: { url: "http://x" } } }),
      );
      await cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd);
      const written = await read();
      expect(written.otherTopLevel).toBe("keep");
      expect(written.mcpServers?.other).toEqual({ url: "http://x" });
      expect(written.mcpServers?.clerk).toEqual(CURRENT_SHAPE);
    });

    test("re-installing is idempotent and still reports installed", async () => {
      await cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd);
      const result = await cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd);
      expect(result.status).toBe("installed");
      const written = await read();
      expect(written.mcpServers?.clerk).toEqual(CURRENT_SHAPE);
    });

    test("upgrades a legacy same-URL entry (bare { url }) to the bridge shape", async () => {
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        join(cwd, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { clerk: { url: CLERK_URL } } }),
      );
      const result = await cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd);
      expect(result.status).toBe("installed");
      const written = await read();
      expect(written.mcpServers?.clerk).toEqual(CURRENT_SHAPE);
    });

    test("overwrites an entry pointing at a foreign server (install always converges)", async () => {
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        join(cwd, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: { clerk: FOREIGN_SHAPE } }),
      );
      const result = await cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd);
      expect(result.status).toBe("installed");
      const written = await read();
      expect(written.mcpServers?.clerk).toEqual(CURRENT_SHAPE);
    });

    test("rejects a config whose top-level is not an object", async () => {
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(join(cwd, ".cursor", "mcp.json"), "[1,2,3]");
      await expect(cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd)).rejects.toThrow(
        /not a JSON object/,
      );
    });

    test("writes an entry whose name shadows an inherited Object property", async () => {
      // `toString` lives on Object.prototype; the write must land as an own
      // property rather than being confused by the inherited function.
      const result = await cursorClient.upsert({ name: "toString", url: CLERK_URL }, cwd);
      expect(result.status).toBe("installed");
      const written = await read();
      expect(written.mcpServers?.["toString"]).toEqual(CURRENT_SHAPE);
    });
  });

  describe("remove", () => {
    test("removes a present entry", async () => {
      await cursorClient.upsert({ name: "clerk", url: CLERK_URL }, cwd);
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
            clerk: { url: CLERK_URL },
            "other-clerk": { url: "https://mcp.clerk.com/mcp" },
            unrelated: { url: "https://example.com/mcp" },
          },
        }),
      );
      const entries = await cursorClient.list(cwd);
      const names = entries.map((e) => e.name).sort();
      expect(names).toEqual(["clerk", "other-clerk"]);
    });

    test("lists a current-shape entry by name, resolving URL from getMcpUrl()", async () => {
      const configPath = join(cwd, ".cursor", "mcp.json");
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(configPath, JSON.stringify({ mcpServers: { clerk: CURRENT_SHAPE } }));
      const entries = await cursorClient.list(cwd);
      expect(entries).toHaveLength(1);
      expect(entries[0]!.name).toBe("clerk");
      expect(entries[0]!.url).toBe(CLERK_URL);
    });

    test("returns empty when no config file exists", async () => {
      const entries = await cursorClient.list(cwd);
      expect(entries).toEqual([]);
    });

    test("rejects with MCP_CLIENT_CONFIG_INVALID on malformed JSON", async () => {
      // list() propagates the failure so aggregating callers (collectEntries,
      // uninstall's picker) can report "unreadable config" instead of folding
      // a corrupt file into "no entries".
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(join(cwd, ".cursor", "mcp.json"), "not json");
      await expect(cursorClient.list(cwd)).rejects.toMatchObject({
        code: "mcp_client_config_invalid",
      });
    });

    test("rejects with MCP_CLIENT_CONFIG_INVALID when the top-level key is not an object", async () => {
      // Valid JSON, wrong shape: `mcpServers` is an array.
      await mkdir(join(cwd, ".cursor"), { recursive: true });
      await writeFile(
        join(cwd, ".cursor", "mcp.json"),
        JSON.stringify({ mcpServers: ["not", "an", "object"] }),
      );
      await expect(cursorClient.list(cwd)).rejects.toMatchObject({
        code: "mcp_client_config_invalid",
      });
    });
  });
});

describe("makeReadOnlyJsonClient (CLI-delegated bases)", () => {
  // The invariant behind CLI delegation: configs owned by a client's CLI are
  // never written by us. A write reaching a read-only base is a wiring bug.
  const readOnly = makeReadOnlyJsonClient({
    id: "claude",
    displayName: "ReadOnly",
    scope: "user",
    activation: "n/a",
    topKey: "mcpServers",
    encode: () => CURRENT_SHAPE,
    extractUrl: () => CLERK_URL,
    configPath: (cwd) => join(cwd, "readonly.json"),
  });

  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-readonly-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  test("reads entries but refuses upsert and remove", async () => {
    await writeFile(
      join(cwd, "readonly.json"),
      JSON.stringify({ mcpServers: { clerk: CURRENT_SHAPE } }),
    );
    expect((await readOnly.list(cwd)).map((e) => e.name)).toEqual(["clerk"]);
    await expect(readOnly.upsert({ name: "clerk", url: CLERK_URL }, cwd)).rejects.toThrow(
      /delegated/,
    );
    await expect(readOnly.remove("clerk", cwd)).rejects.toThrow(/delegated/);
  });
});

describe("make-client nested topKey (OpenClaw-style mcp.servers)", () => {
  // OpenClaw nests its server map two levels deep (`mcp.servers.<name>`); the
  // factory takes the key path as an array and must preserve sibling keys at
  // every level and prune only empty objects it owns on remove.
  const nested = makeJsonClient({
    id: "openclaw",
    displayName: "Nested",
    scope: "user",
    activation: "n/a",
    topKey: ["mcp", "servers"],
    encode: () => CURRENT_SHAPE,
    extractUrl: (d) =>
      typeof d === "object" && d !== null && "command" in d ? CLERK_URL : undefined,
    configPath: (cwd) => join(cwd, "openclaw.json"),
  });

  let cwd: string;

  beforeEach(async () => {
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-nested-"));
  });

  afterEach(async () => {
    await rm(cwd, { recursive: true, force: true });
  });

  async function read(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(join(cwd, "openclaw.json"), "utf8"));
  }

  test("upsert writes the entry under the nested path", async () => {
    const result = await nested.upsert({ name: "clerk", url: CLERK_URL }, cwd);
    expect(result.status).toBe("installed");
    expect(await read()).toEqual({ mcp: { servers: { clerk: CURRENT_SHAPE } } });
  });

  test("upsert preserves sibling keys at both levels", async () => {
    await writeFile(
      join(cwd, "openclaw.json"),
      JSON.stringify({
        agents: { keep: true },
        mcp: { timeout: 5, servers: { other: { command: "x", args: [] } } },
      }),
    );
    await nested.upsert({ name: "clerk", url: CLERK_URL }, cwd);
    expect(await read()).toEqual({
      agents: { keep: true },
      mcp: {
        timeout: 5,
        servers: { other: { command: "x", args: [] }, clerk: CURRENT_SHAPE },
      },
    });
  });

  test("remove prunes empty maps up the path but keeps non-empty ancestors", async () => {
    await writeFile(
      join(cwd, "openclaw.json"),
      JSON.stringify({ mcp: { timeout: 5, servers: { clerk: CURRENT_SHAPE } } }),
    );
    const result = await nested.remove("clerk", cwd);
    expect(result.removed).toBe(true);
    // `servers` became empty and is dropped; `mcp` still holds `timeout`.
    expect(await read()).toEqual({ mcp: { timeout: 5 } });
  });

  test("remove drops the whole chain when nothing else remains", async () => {
    await nested.upsert({ name: "clerk", url: CLERK_URL }, cwd);
    await nested.remove("clerk", cwd);
    expect(await read()).toEqual({});
  });

  test("list resolves entries under the nested path", async () => {
    await nested.upsert({ name: "clerk", url: CLERK_URL }, cwd);
    const entries = await nested.list(cwd);
    expect(entries).toEqual([
      expect.objectContaining({ client: "openclaw", name: "clerk", url: CLERK_URL }),
    ]);
  });

  test("rejects when an intermediate key is not an object", async () => {
    await writeFile(join(cwd, "openclaw.json"), JSON.stringify({ mcp: "nope" }));
    await expect(nested.list(cwd)).rejects.toMatchObject({ code: "mcp_client_config_invalid" });
  });
});
