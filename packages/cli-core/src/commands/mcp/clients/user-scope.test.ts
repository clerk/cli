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
const { codexClient } = await import("./codex.ts");
const { vscodeUserDir } = await import("./paths.ts");
const { parse: parseToml } = await import("smol-toml");
const { mcpInstall } = await import("../install.ts");
const { mcpUninstall } = await import("../uninstall.ts");
const { checkMcp } = await import("../../doctor/check-mcp.ts");

const captured = useCaptureLog();

// The URL the default env profile resolves to (same as getMcpUrl() default).
const DEFAULT_URL = "https://mcp.clerk.com/mcp";
const ALL_CLIENT_IDS = ["claude", "cursor", "vscode", "windsurf", "gemini", "codex"];

// The entry shape written by the current CLI — no URL in args.
const CURRENT_SHAPE = { command: "clerk", args: ["mcp", "run"] };

describe("user-scope MCP clients (homedir redirected to a tmpdir)", () => {
  beforeEach(async () => {
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-home-"));
  });

  afterEach(async () => {
    await rm(mockHome, { recursive: true, force: true });
  });

  describe("gemini", () => {
    test("encodes the clerk-run stdio-bridge shape (no URL in args)", async () => {
      await geminiClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored", false);
      const parsed = (await Bun.file(geminiClient.configPath("/ignored")).json()) as {
        mcpServers: { clerk: { command: string; args: string[] } };
      };
      expect(parsed.mcpServers.clerk).toEqual(CURRENT_SHAPE);
    });

    test("round-trips the entry on list, resolving URL from getMcpUrl()", async () => {
      await geminiClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored", false);
      const entries = await geminiClient.list("/ignored");
      expect(entries).toEqual([
        expect.objectContaining({ client: "gemini", name: "clerk", url: DEFAULT_URL }),
      ]);
    });

    test("recognises a legacy npx mcp-remote entry by its Clerk URL in args", async () => {
      // Legacy shape: `npx -y mcp-remote <url>` — identified by the Clerk URL in
      // args rather than the command name (more robust to npx/bunx/pnpx variants).
      const dir = join(mockHome, ".gemini");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "settings.json"),
        JSON.stringify({
          mcpServers: {
            clerk: { command: "npx", args: ["-y", "mcp-remote", DEFAULT_URL] },
          },
        }),
      );
      const entries = await geminiClient.list("/ignored");
      expect(entries.map((e) => e.name)).toEqual(["clerk"]);
      expect(entries[0]!.url).toBe(DEFAULT_URL);
    });

    test("ignores a foreign npx entry without a Clerk URL in args", async () => {
      const dir = join(mockHome, ".gemini");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "settings.json"),
        JSON.stringify({
          mcpServers: {
            clerk: { command: "npx", args: ["-y", "mcp-remote", DEFAULT_URL] },
            "other-tool": { command: "npx", args: ["serve", "--port", "3000"] },
          },
        }),
      );
      const entries = await geminiClient.list("/ignored");
      expect(entries.map((e) => e.name)).toEqual(["clerk"]);
    });
  });

  describe("windsurf", () => {
    test("encodes the clerk-run shape and round-trips it on list", async () => {
      await windsurfClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored", false);
      const parsed = (await Bun.file(windsurfClient.configPath("/ignored")).json()) as {
        mcpServers: { clerk: { command: string; args: string[] } };
      };
      expect(parsed.mcpServers.clerk).toEqual(CURRENT_SHAPE);

      const entries = await windsurfClient.list("/ignored");
      expect(entries).toEqual([
        expect.objectContaining({ client: "windsurf", name: "clerk", url: DEFAULT_URL }),
      ]);
    });
  });

  describe("codex", () => {
    test("writes the clerk-run bridge under the [mcp_servers.<name>] TOML table", async () => {
      await codexClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored", false);
      const text = await Bun.file(codexClient.configPath("/ignored")).text();
      expect(text).toContain("[mcp_servers.clerk]");
      const parsed = parseToml(text) as {
        mcp_servers: { clerk: { command: string; args: string[] } };
      };
      expect(parsed.mcp_servers.clerk).toEqual(CURRENT_SHAPE);
    });

    test("round-trips the entry on list, resolving URL from getMcpUrl()", async () => {
      await codexClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored", false);
      const entries = await codexClient.list("/ignored");
      expect(entries).toEqual([
        expect.objectContaining({ client: "codex", name: "clerk", url: DEFAULT_URL }),
      ]);
    });

    test("preserves unrelated top-level keys on upsert", async () => {
      const dir = join(mockHome, ".codex");
      await mkdir(dir, { recursive: true });
      await Bun.write(join(dir, "config.toml"), 'model = "o3"\n');

      await codexClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored", false);

      const parsed = parseToml(await Bun.file(join(dir, "config.toml")).text()) as {
        model: string;
        mcp_servers: { clerk: { command: string; args: string[] } };
      };
      expect(parsed.model).toBe("o3");
      expect(parsed.mcp_servers.clerk).toEqual(CURRENT_SHAPE);
    });

    test("returns unchanged when re-upserting the same URL", async () => {
      await codexClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored", false);
      const result = await codexClient.upsert(
        { name: "clerk", url: DEFAULT_URL },
        "/ignored",
        false,
      );
      expect(result.status).toBe("unchanged");
    });

    test("preserves unrelated tables when removing the entry", async () => {
      const dir = join(mockHome, ".codex");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "config.toml"),
        'model = "o3"\n\n[mcp_servers.clerk]\nurl = "https://mcp.clerk.com/mcp"\n\n[mcp_servers.other]\ncommand = "npx"\n',
      );

      await codexClient.remove("clerk", "/ignored");

      const parsed = parseToml(await Bun.file(join(dir, "config.toml")).text()) as {
        model: string;
        mcp_servers: Record<string, unknown>;
      };
      expect(parsed.model).toBe("o3"); // top-level key untouched
      expect(parsed.mcp_servers.clerk).toBeUndefined(); // removed
      expect(parsed.mcp_servers.other).toEqual({ command: "npx" }); // sibling kept
    });
  });
});

// These exercise the command-level "all clients" defaults, which touch the
// user-scoped clients (gemini, windsurf) — so they live here, alongside the
// single homedir redirect, rather than in a second file that re-mocks node:os.
describe("install/uninstall across all clients (homedir + cwd redirected)", () => {
  let cwd: string;
  let originalCwd: string;
  let origXdgConfigHome: string | undefined;
  let origAppData: string | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-all-cwd-"));
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-all-home-"));
    origXdgConfigHome = process.env.XDG_CONFIG_HOME;
    origAppData = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = "";
    process.env.APPDATA = "";
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(true);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (origXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdgConfigHome;
    }
    if (origAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = origAppData;
    }
    await rm(cwd, { recursive: true, force: true });
    await rm(mockHome, { recursive: true, force: true });
    mockIsAgent.mockReset();
  });

  test("install --all targets every detected client", async () => {
    // detect() keys off each client's marker directory under home (VS Code uses
    // its per-OS user config dir).
    await Promise.all([
      mkdir(join(mockHome, ".claude"), { recursive: true }),
      mkdir(join(mockHome, ".cursor"), { recursive: true }),
      mkdir(vscodeUserDir(), { recursive: true }),
      mkdir(join(mockHome, ".codeium", "windsurf"), { recursive: true }),
      mkdir(join(mockHome, ".gemini"), { recursive: true }),
      mkdir(join(mockHome, ".codex"), { recursive: true }),
    ]);

    await mcpInstall({ all: true });

    const payload = JSON.parse(captured.out) as { results: { client: string; status: string }[] };
    expect(payload.results.map((r) => r.client)).toEqual(ALL_CLIENT_IDS);
    expect(payload.results.every((r) => r.status === "added")).toBe(true);
  });

  test("--all with no detected client throws mcp_no_client_detected", async () => {
    await expect(mcpInstall({ all: true })).rejects.toMatchObject({
      code: "mcp_no_client_detected",
    });
  });

  test("auto-selects the sole detected client without prompting", async () => {
    await mkdir(join(mockHome, ".cursor"), { recursive: true });
    mockIsAgent.mockReturnValue(false);

    await mcpInstall({});

    const parsed = JSON.parse(await Bun.file(join(mockHome, ".cursor", "mcp.json")).text()) as {
      mcpServers: { clerk: unknown };
    };
    expect(parsed.mcpServers.clerk).toEqual(CURRENT_SHAPE);
  });

  test("uninstall with no --client removes from every client", async () => {
    await mcpInstall({ client: ["cursor", "gemini"] });
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
  let origXdgConfigHome: string | undefined;
  let origAppData: string | undefined;
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
    origXdgConfigHome = process.env.XDG_CONFIG_HOME;
    origAppData = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = "";
    process.env.APPDATA = "";
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(true);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (origXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = origXdgConfigHome;
    }
    if (origAppData === undefined) {
      delete process.env.APPDATA;
    } else {
      process.env.APPDATA = origAppData;
    }
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
    await mcpInstall({ client: ["cursor"] });
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
    await mcpInstall({ client: ["cursor"] });
    captured.clear();
    stubFetchWith("nope", { status: 503 });

    const result = await checkMcp();
    expect(result.status).toBe("warn");
  });

  test("names the unreachable URL in the warning", async () => {
    await mcpInstall({ client: ["cursor"] });
    captured.clear();
    stubFetchWith("nope", { status: 503 });

    const result = await checkMcp();
    expect(result.status).toBe("warn");
    expect(result.message).toContain(DEFAULT_URL);
  });
});
