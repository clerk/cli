import type { findClientBinary, runClientCli } from "./cli-exec.ts";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import * as realOs from "node:os";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

// Gemini and Windsurf read/write under the user's home (`~/.gemini`,
// `~/.codeium`), so their logic can't be exercised through a cwd tmpdir like
// project-scope paths. Bun's os.homedir() ignores $HOME, so redirect it via the
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

// CLI-backed clients (claude, gemini, codex, vscode, openclaw, hermes) delegate writes to their
// own CLI; stub the subprocess layer so no real binaries are required.
const mockRun = mock<typeof runClientCli>();
const mockWhich = mock<typeof findClientBinary>();
mock.module("./cli-exec.ts", () => ({
  findClientBinary: mockWhich,
  runClientCli: mockRun,
}));

const { geminiClient } = await import("./gemini.ts");
const { windsurfClient } = await import("./windsurf.ts");
const { codexClient } = await import("./codex.ts");
const { mcpInstall } = await import("../install.ts");
const { mcpUninstall } = await import("../uninstall.ts");
const { checkMcp } = await import("../../doctor/check-mcp.ts");

const captured = useCaptureLog();

// The URL the default env profile resolves to (same as getMcpUrl() default).
const DEFAULT_URL = "https://mcp.clerk.com/mcp";
const ALL_CLIENT_IDS = [
  "claude",
  "cursor",
  "vscode",
  "windsurf",
  "gemini",
  "codex",
  "opencode",
  "openclaw",
  "warp",
  "hermes",
];

// The entry shape the bridge registers — no URL in args.
const CURRENT_SHAPE = { command: "clerk", args: ["mcp", "run"] };

describe("user-scope MCP clients (homedir redirected)", () => {
  beforeEach(async () => {
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-home-"));
    mockWhich.mockImplementation((binary: string) => `/fake/bin/${binary}`);
    mockRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });

  afterEach(async () => {
    await rm(mockHome, { recursive: true, force: true });
    mockWhich.mockReset();
    mockRun.mockReset();
  });

  describe("gemini (reads configs written by the gemini CLI)", () => {
    test("round-trips a current-shape entry on list, resolving URL from getMcpUrl()", async () => {
      const dir = join(mockHome, ".gemini");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "settings.json"),
        JSON.stringify({ mcpServers: { clerk: CURRENT_SHAPE } }),
      );
      const entries = await geminiClient.list("/ignored");
      expect(entries).toEqual([
        expect.objectContaining({ client: "gemini", name: "clerk", url: DEFAULT_URL }),
      ]);
    });

    test("ignores foreign stdio entries that are not the clerk bridge", async () => {
      const dir = join(mockHome, ".gemini");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "settings.json"),
        JSON.stringify({
          mcpServers: {
            clerk: CURRENT_SHAPE,
            "other-tool": { command: "npx", args: ["serve", "--port", "3000"] },
          },
        }),
      );
      const entries = await geminiClient.list("/ignored");
      expect(entries.map((e) => e.name)).toEqual(["clerk"]);
    });
  });

  describe("windsurf (file-backed — we write the config ourselves)", () => {
    test("encodes the clerk-run shape and round-trips it on list", async () => {
      await windsurfClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored");
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

  describe("codex (reads the TOML config written by the codex CLI)", () => {
    test("round-trips a [mcp_servers.<name>] entry on list, resolving URL from getMcpUrl()", async () => {
      const dir = join(mockHome, ".codex");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "config.toml"),
        '[mcp_servers.clerk]\ncommand = "clerk"\nargs = ["mcp", "run"]\n',
      );
      const entries = await codexClient.list("/ignored");
      expect(entries).toEqual([
        expect.objectContaining({ client: "codex", name: "clerk", url: DEFAULT_URL }),
      ]);
    });

    test("ignores a direct-URL entry the CLI never wrote, even under the clerk name", async () => {
      const dir = join(mockHome, ".codex");
      await mkdir(dir, { recursive: true });
      await Bun.write(
        join(dir, "config.toml"),
        'model = "o3"\n\n[mcp_servers.clerk]\nurl = "https://mcp.clerk.com/mcp"\n',
      );
      const entries = await codexClient.list("/ignored");
      expect(entries).toEqual([]);
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
    mockWhich.mockImplementation((binary: string) => `/fake/bin/${binary}`);
    mockRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
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
    mockWhich.mockReset();
    mockRun.mockReset();
  });

  test("install --all targets every detected client", async () => {
    // File-backed clients (cursor, windsurf, opencode, warp) are detected via
    // their marker directory; CLI-backed clients via their binary on PATH
    // (mocked found).
    await Promise.all([
      mkdir(join(mockHome, ".cursor"), { recursive: true }),
      mkdir(join(mockHome, ".codeium", "windsurf"), { recursive: true }),
      mkdir(join(mockHome, ".config", "opencode"), { recursive: true }),
      mkdir(join(mockHome, ".warp"), { recursive: true }),
      mkdir(join(mockHome, ".hermes"), { recursive: true }),
    ]);
    // Hermes verifies its entry landed after add (its CLI can exit 0 without
    // saving); the mocked CLI writes nothing, so seed the config it would have
    // written.
    await Bun.write(
      join(mockHome, ".hermes", "config.yaml"),
      "mcp_servers:\n  clerk:\n    command: clerk\n    args: [mcp, run]\n",
    );

    await mcpInstall({ all: true });

    const payload = JSON.parse(captured.out) as { results: { client: string; status: string }[] };
    expect(payload.results.map((r) => r.client)).toEqual(ALL_CLIENT_IDS);
    expect(payload.results.every((r) => r.status === "installed")).toBe(true);
  });

  test("--all with no detected client throws mcp_no_client_detected linking the setup docs", async () => {
    mockWhich.mockReturnValue(null); // no client CLI on PATH, no config dirs
    await expect(mcpInstall({ all: true })).rejects.toMatchObject({
      code: "mcp_no_client_detected",
      docsUrl: expect.stringContaining("https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server"),
    });
  });

  test("auto-selects the sole detected client without prompting", async () => {
    await mkdir(join(mockHome, ".cursor"), { recursive: true });
    mockWhich.mockReturnValue(null); // no CLI-backed client available
    mockIsAgent.mockReturnValue(false);

    await mcpInstall({});

    const parsed = JSON.parse(await Bun.file(join(mockHome, ".cursor", "mcp.json")).text()) as {
      mcpServers: { clerk: unknown };
    };
    expect(parsed.mcpServers.clerk).toEqual(CURRENT_SHAPE);
  });

  test("uninstall with no --client removes from every client", async () => {
    await mcpInstall({ client: ["cursor"] });
    // Gemini's entry exists as its own CLI would have registered it.
    await mkdir(join(mockHome, ".gemini"), { recursive: true });
    await Bun.write(
      join(mockHome, ".gemini", "settings.json"),
      JSON.stringify({ mcpServers: { clerk: CURRENT_SHAPE } }),
    );
    // Simulate the gemini CLI mutating its own config — the factory re-reads
    // it after a successful remove and refuses to report a phantom removal.
    mockRun.mockImplementation(async (argv: string[]) => {
      if (argv.includes("remove")) {
        await rm(join(mockHome, ".gemini", "settings.json"), { force: true });
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    captured.clear();

    await mcpUninstall({});

    const payload = JSON.parse(captured.out) as { results: { client: string; removed: boolean }[] };
    expect(payload.results.map((r) => r.client).sort()).toEqual([...ALL_CLIENT_IDS].sort());
    expect(payload.results.find((r) => r.client === "cursor")?.removed).toBe(true);
    expect(payload.results.find((r) => r.client === "gemini")?.removed).toBe(true);
    // Gemini's removal went through its CLI, not a file edit of ours.
    expect(mockRun).toHaveBeenCalledWith([
      "/fake/bin/gemini",
      "mcp",
      "remove",
      "--scope",
      "user",
      "clerk",
    ]);
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
    mockWhich.mockImplementation((binary: string) => `/fake/bin/${binary}`);
    mockRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
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
    mockWhich.mockReset();
    mockRun.mockReset();
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
