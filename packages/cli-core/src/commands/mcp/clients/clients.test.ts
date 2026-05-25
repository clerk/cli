import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { claudeCodeClient } from "./claude-code.ts";
import { cursorClient } from "./cursor.ts";
import { vscodeClient } from "./vscode.ts";
import { windsurfClient } from "./windsurf.ts";
import { geminiClient } from "./gemini.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

useCaptureLog();

const URL = "https://mcp.clerk.com/mcp";

// Path shape is part of the public contract — each client targets a specific,
// documented config file. Test against the format, not the absolute prefix
// (which depends on cwd/homedir).
const projectClients = [
  { client: claudeCodeClient, suffix: ".mcp.json", topKey: "mcpServers" },
  { client: cursorClient, suffix: join(".cursor", "mcp.json"), topKey: "mcpServers" },
  { client: vscodeClient, suffix: join(".vscode", "mcp.json"), topKey: "servers" },
];

const userClients = [
  {
    client: windsurfClient,
    relPath: join(".codeium", "windsurf", "mcp_config.json"),
    topKey: "mcpServers",
  },
  { client: geminiClient, relPath: join(".gemini", "settings.json"), topKey: "mcpServers" },
];

describe("project-scope client config paths", () => {
  test.each(projectClients)("$client.id resolves under cwd", ({ client, suffix }) => {
    const path = client.configPath("/tmp/foo");
    expect(path).toBe(join("/tmp/foo", suffix));
    expect(client.scope).toBe("project");
  });
});

describe("user-scope client config paths", () => {
  test.each(userClients)("$client.id resolves under homedir", ({ client, relPath }) => {
    expect(client.configPath("/ignored")).toBe(join(homedir(), relPath));
    expect(client.scope).toBe("user");
  });
});

describe("per-client encoded shape (written JSON)", () => {
  // Project clients are easiest to exercise — write into a tmpdir-as-cwd and
  // assert what landed under their top-level key.
  test.each(projectClients)(
    "$client.id writes the expected entry shape",
    async ({ client, topKey }) => {
      const cwd = await mkdtemp(join(tmpdir(), `clerk-mcp-${client.id}-`));
      try {
        await client.upsert({ name: "clerk", url: URL }, cwd, false);
        const text = await readFile(client.configPath(cwd), "utf8");
        const parsed = JSON.parse(text) as Record<string, Record<string, unknown>>;
        expect(parsed[topKey]).toBeDefined();
        expect(parsed[topKey]?.clerk).toBeDefined();
      } finally {
        await rm(cwd, { recursive: true, force: true });
      }
    },
  );

  test("claude-code emits the MCP-spec HTTP transport shape", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "clerk-mcp-cc-shape-"));
    try {
      await claudeCodeClient.upsert({ name: "clerk", url: URL }, cwd, false);
      const parsed = JSON.parse(await readFile(claudeCodeClient.configPath(cwd), "utf8")) as {
        mcpServers: { clerk: { type: string; url: string } };
      };
      expect(parsed.mcpServers.clerk).toEqual({ type: "http", url: URL });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("cursor emits a bare {url} entry", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "clerk-mcp-cu-shape-"));
    try {
      await cursorClient.upsert({ name: "clerk", url: URL }, cwd, false);
      const parsed = JSON.parse(await readFile(cursorClient.configPath(cwd), "utf8")) as {
        mcpServers: { clerk: { url: string } };
      };
      expect(parsed.mcpServers.clerk).toEqual({ url: URL });
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("vscode emits under top-level `servers`, not `mcpServers`", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "clerk-mcp-vs-shape-"));
    try {
      await vscodeClient.upsert({ name: "clerk", url: URL }, cwd, false);
      const parsed = JSON.parse(await readFile(vscodeClient.configPath(cwd), "utf8")) as {
        servers: { clerk: { type: string; url: string } };
        mcpServers?: unknown;
      };
      expect(parsed.servers.clerk).toEqual({ type: "http", url: URL });
      expect(parsed.mcpServers).toBeUndefined();
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
