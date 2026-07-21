import { beforeEach, describe, expect, mock, test } from "bun:test";
import { useCaptureLog } from "../../test/lib/stubs.ts";
import type { CollectResult } from "../mcp/collect.ts";
import type { McpProbeResult } from "../mcp/probe.ts";
import type { ListEntry } from "../mcp/clients/types.ts";

let collected: CollectResult;
let probes: Record<string, McpProbeResult>;
let probedUrls: string[];

// Registered at file top, before check-mcp.ts loads its imports (this file
// runs in its own subprocess via scripts/run-tests.ts).
mock.module("../mcp/collect.ts", () => ({
  collectEntries: async () => collected,
}));
mock.module("../mcp/probe.ts", () => ({
  probeMcp: async (url: string): Promise<McpProbeResult> => {
    probedUrls.push(url);
    return probes[url] ?? { ok: false, error: "unstubbed url" };
  },
}));

const { checkMcp } = await import("./check-mcp.ts");

const HOSTED = "https://mcp.clerk.com/mcp";
const LOCAL = "http://localhost:9000/mcp";

function entry(client: ListEntry["client"], url: string): ListEntry {
  return { client, configPath: `/tmp/${client}.json`, name: "clerk", url };
}

describe("checkMcp", () => {
  useCaptureLog();

  beforeEach(() => {
    collected = { entries: [], failures: [] };
    probes = {};
    probedUrls = [];
  });

  test("passes as skipped when nothing is installed", async () => {
    const result = await checkMcp();

    expect(result.status).toBe("pass");
    expect(result.message).toContain("Skipped");
  });

  test("warns naming the client when a config is unreadable, instead of passing as skipped", async () => {
    collected = {
      entries: [],
      failures: [
        {
          client: "claude",
          displayName: "Claude Code",
          message: "Could not parse ~/.claude.json as JSON",
        },
      ],
    };

    const result = await checkMcp();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Claude Code");
    expect(result.detail).toContain("Could not parse");
    expect(result.remedy).toContain("clerk mcp install");
  });

  test("still reports probe failures alongside an unreadable config", async () => {
    collected = {
      entries: [entry("cursor", LOCAL)],
      failures: [{ client: "claude", displayName: "Claude Code", message: "unreadable" }],
    };
    probes = { [LOCAL]: { ok: false, status: 502 } };

    const result = await checkMcp();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Claude Code");
    expect(result.detail).toContain(`${LOCAL}: HTTP 502`);
  });

  test("passes with server names when every distinct URL is reachable, probing each once", async () => {
    collected = {
      entries: [entry("claude", HOSTED), entry("cursor", HOSTED)],
      failures: [],
    };
    probes = { [HOSTED]: { ok: true, status: 200, serverName: "Clerk MCP Server" } };

    const result = await checkMcp();

    expect(result.status).toBe("pass");
    expect(result.message).toBe(`Reachable — Clerk MCP Server (${HOSTED})`);
    expect(probedUrls).toEqual([HOSTED]);
  });

  test("warns with singular wording when the only configured server is unreachable", async () => {
    collected = { entries: [entry("claude", LOCAL)], failures: [] };
    probes = { [LOCAL]: { ok: false, error: "fetch failed" } };

    const result = await checkMcp();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("Configured MCP server is not reachable");
    expect(result.detail).toBe(`${LOCAL}: fetch failed`);
  });

  test("a healthy first URL does not mask a broken second", async () => {
    collected = {
      entries: [entry("claude", HOSTED), entry("cursor", LOCAL)],
      failures: [],
    };
    probes = {
      [HOSTED]: { ok: true, status: 200, serverName: "Clerk MCP Server" },
      [LOCAL]: { ok: false, error: "fetch failed" },
    };

    const result = await checkMcp();

    expect(result.status).toBe("warn");
    expect(result.message).toContain("One or more configured MCP servers are not reachable");
    expect(result.message).toContain(LOCAL);
    expect(result.message).not.toContain(HOSTED);
  });
});
