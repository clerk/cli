import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import * as realOs from "node:os";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

// Gemini and Windsurf write under the user's home (`~/.gemini`, `~/.codeium`),
// so their encode/extract logic can't be exercised through a cwd tmpdir like the
// project-scope clients. Bun's os.homedir() ignores $HOME, so redirect it via the
// module mock instead — registered at file top, before the clients are imported.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));
afterAll(() => mock.restore());

const mockIsAgent = mock();
mock.module("../../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => (mockIsAgent() ? "agent" : "human"),
}));

const { geminiClient } = await import("./gemini.ts");
const { windsurfClient } = await import("./windsurf.ts");
const { mcpInstall } = await import("../install.ts");
const { mcpUninstall } = await import("../uninstall.ts");
const { checkMcp } = await import("../../doctor/check-mcp.ts");

const captured = useCaptureLog();

const URL = "https://mcp.clerk.com/mcp";
const ALL_CLIENT_IDS = ["claude-code", "cursor", "vscode", "windsurf", "gemini"];

describe("user-scope MCP clients (homedir redirected to a tmpdir)", () => {
  beforeEach(async () => {
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-home-"));
  });

  afterEach(async () => {
    await rm(mockHome, { recursive: true, force: true });
  });

  describe("gemini", () => {
    test("encodes the mcp-remote stdio-bridge shape", async () => {
      await geminiClient.upsert({ name: "clerk", url: URL }, "/ignored", false);
      const parsed = (await Bun.file(geminiClient.configPath("/ignored")).json()) as {
        mcpServers: { clerk: { command: string; args: string[] } };
      };
      expect(parsed.mcpServers.clerk).toEqual({ command: "npx", args: ["-y", "mcp-remote", URL] });
    });

    test("round-trips the URL back out of args[2] on list", async () => {
      await geminiClient.upsert({ name: "clerk", url: URL }, "/ignored", false);
      const entries = await geminiClient.list("/ignored");
      expect(entries).toEqual([
        expect.objectContaining({ client: "gemini", name: "clerk", url: URL }),
      ]);
    });

    test("ignores a foreign npx entry that is not an mcp-remote bridge", async () => {
      // Only `{command:"npx", args:["-y","mcp-remote", <url>]}` is ours; an
      // unrelated npx tool must not round-trip as a Clerk MCP entry.
      const dir = join(mockHome, ".gemini");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "settings.json"),
        JSON.stringify({
          mcpServers: {
            clerk: { command: "npx", args: ["-y", "mcp-remote", URL] },
            "other-tool": { command: "npx", args: ["serve", "--port", "3000"] },
          },
        }),
      );
      const entries = await geminiClient.list("/ignored");
      expect(entries.map((e) => e.name)).toEqual(["clerk"]);
    });
  });

  describe("windsurf", () => {
    test("encodes the serverUrl shape and round-trips it on list", async () => {
      await windsurfClient.upsert({ name: "clerk", url: URL }, "/ignored", false);
      const parsed = (await Bun.file(windsurfClient.configPath("/ignored")).json()) as {
        mcpServers: { clerk: { serverUrl: string } };
      };
      expect(parsed.mcpServers.clerk).toEqual({ serverUrl: URL });

      const entries = await windsurfClient.list("/ignored");
      expect(entries).toEqual([
        expect.objectContaining({ client: "windsurf", name: "clerk", url: URL }),
      ]);
    });
  });
});

// These exercise the command-level "all clients" defaults, which touch the
// user-scoped clients (gemini, windsurf) — so they live here, alongside the
// single homedir redirect, rather than in a second file that re-mocks node:os.
describe("install/uninstall across all clients (homedir + cwd redirected)", () => {
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-all-cwd-"));
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-all-home-"));
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(true);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    await rm(mockHome, { recursive: true, force: true });
    mockIsAgent.mockReset();
  });

  test("install --all targets every detected client", async () => {
    // detect() keys off each client's marker directory under home.
    await Promise.all([
      mkdir(join(mockHome, ".claude"), { recursive: true }),
      mkdir(join(mockHome, ".cursor"), { recursive: true }),
      mkdir(join(mockHome, ".vscode"), { recursive: true }),
      mkdir(join(mockHome, ".codeium", "windsurf"), { recursive: true }),
      mkdir(join(mockHome, ".gemini"), { recursive: true }),
    ]);

    await mcpInstall({ all: true, url: URL });

    const payload = JSON.parse(captured.out) as { results: { client: string; status: string }[] };
    expect(payload.results.map((r) => r.client).sort()).toEqual([...ALL_CLIENT_IDS].sort());
    expect(payload.results.every((r) => r.status === "added")).toBe(true);
  });

  test("uninstall with no --client removes from every client", async () => {
    await mcpInstall({ client: ["cursor", "gemini"], url: URL });
    captured.clear();

    await mcpUninstall({});

    const payload = JSON.parse(captured.out) as { results: { client: string; removed: boolean }[] };
    expect(payload.results.map((r) => r.client).sort()).toEqual([...ALL_CLIENT_IDS].sort());
    expect(payload.results.find((r) => r.client === "cursor")?.removed).toBe(true);
    expect(payload.results.find((r) => r.client === "gemini")?.removed).toBe(true);
  });
});

// `clerk doctor`'s MCP check (folded in from the former `clerk mcp doctor`).
// Lives here because it scans the user-scoped clients, needing the homedir
// redirect; a second os-mocking file would collide in the single-process runner.
describe("clerk doctor — checkMcp (homedir + cwd redirected)", () => {
  let cwd: string;
  let originalCwd: string;
  const originalFetch = globalThis.fetch;

  // Assign globalThis.fetch directly (cast to its own type) rather than via the
  // typed stubFetch helper: this file imports node:* which pulls in undici's
  // `Response` type, and stubFetch expects Bun's — the two aren't assignable.
  function stubFetchWith(body: string, init: ResponseInit): void {
    globalThis.fetch = (async () => new Response(body, init)) as unknown as typeof globalThis.fetch;
  }

  const HANDSHAKE_BODY = `event: message\ndata: {"result":{"serverInfo":{"name":"Clerk MCP Server"}},"jsonrpc":"2.0","id":1}\n\n`;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-check-cwd-"));
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-check-home-"));
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(true);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    await rm(mockHome, { recursive: true, force: true });
    globalThis.fetch = originalFetch;
    mockIsAgent.mockReset();
  });

  test("passes (skipped) when no MCP entry is installed", async () => {
    const result = await checkMcp();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("Skipped");
  });

  test("passes when the installed MCP server answers the handshake", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    captured.clear();
    stubFetchWith(HANDSHAKE_BODY, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    });

    const result = await checkMcp();
    expect(result.status).toBe("pass");
    expect(result.message).toContain("Reachable");
  });

  test("warns when the installed MCP server is unreachable", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    captured.clear();
    stubFetchWith("nope", { status: 503 });

    const result = await checkMcp();
    expect(result.status).toBe("warn");
  });
});
