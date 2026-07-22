import type { findClientBinary, runClientCli } from "./clients/cli-exec.ts";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as realOs from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => (mockIsAgent() ? "agent" : "human"),
}));

// User-scoped clients write under home; redirect homedir to the cwd tmpdir so
// writes stay isolated and `join(cwd, ...)` reads still resolve.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));

const mockMultiselect = mock();
mock.module("../../lib/prompts.ts", () => ({
  multiselect: (...args: unknown[]) => mockMultiselect(...args),
}));

// CLI-backed clients (claude, gemini, codex, openclaw, hermes) delegate removal to their own CLI.
const mockRun = mock<typeof runClientCli>();
const mockWhich = mock<typeof findClientBinary>();
mock.module("./clients/cli-exec.ts", () => ({
  findClientBinary: mockWhich,
  runClientCli: mockRun,
}));
afterAll(() => mock.restore());

const { mcpInstall } = await import("./install.ts");
const { mcpUninstall } = await import("./uninstall.ts");

const URL = "https://mcp.clerk.com/mcp";
const RUN_SHAPE = { command: "clerk", args: ["mcp", "run"] };
const WINDSURF_CONFIG = [".codeium", "windsurf", "mcp_config.json"];

describe("mcp uninstall", () => {
  const captured = useCaptureLog();
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-uninstall-"));
    mockHome = cwd;
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(true);
    mockWhich.mockImplementation((binary: string) => `/fake/bin/${binary}`);
    mockRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    mockIsAgent.mockReset();
    mockMultiselect.mockReset();
    mockWhich.mockReset();
    mockRun.mockReset();
  });

  test("removes the entry an install-uninstall round-trip leaves no trace under mcpServers", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    captured.clear();
    await mcpUninstall({ client: ["cursor"] });

    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    // Removing the only entry drops the now-empty `mcpServers` key entirely
    // rather than leaving `{ "mcpServers": {} }` behind.
    expect(parsed.mcpServers).toBeUndefined();
  });

  test("delegates Claude Code removal to `claude mcp remove`", async () => {
    // Pre-write the entry as Claude Code's own CLI would have registered it.
    await writeFile(
      join(cwd, ".claude.json"),
      JSON.stringify({ mcpServers: { clerk: RUN_SHAPE } }),
    );
    // Simulate the CLI mutating its own config — the factory re-reads it after
    // a successful remove and refuses to report a removal that didn't happen.
    mockRun.mockImplementation(async (argv: string[]) => {
      if (argv.includes("remove")) {
        await writeFile(join(cwd, ".claude.json"), JSON.stringify({ mcpServers: {} }));
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    });
    await mcpUninstall({ client: ["claude"] });

    const payload = JSON.parse(captured.out) as { results: { client: string; removed: boolean }[] };
    expect(payload.results).toEqual([expect.objectContaining({ client: "claude", removed: true })]);
    expect(mockRun).toHaveBeenCalledWith([
      "/fake/bin/claude",
      "mcp",
      "remove",
      "--scope",
      "user",
      "clerk",
    ]);
  });

  test("removes the healthy client and warns when another's config is corrupt", async () => {
    await mcpInstall({ client: ["windsurf"], url: URL });
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");
    captured.clear();

    await mcpUninstall({ client: ["cursor", "windsurf"] });

    const payload = JSON.parse(captured.out) as {
      results: { client: string; removed: boolean }[];
      failures: { client: string; error: string }[];
    };
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "windsurf", removed: true }),
    ]);
    expect(payload.failures).toEqual([expect.objectContaining({ client: "cursor" })]);
    expect(captured.err).toContain("Cursor");
  });

  test("emits JSON results on stdout in agent mode", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    captured.clear();
    await mcpUninstall({ client: ["cursor"] });

    const payload = JSON.parse(captured.out) as {
      name: string;
      results: { client: string; removed: boolean }[];
    };
    expect(payload.name).toBe("clerk");
    expect(payload.results).toEqual([expect.objectContaining({ client: "cursor", removed: true })]);
  });

  test("agent mode: reports removed:false when nothing is registered (no error)", async () => {
    await mcpUninstall({ client: ["cursor"] });
    const payload = JSON.parse(captured.out) as { results: { client: string; removed: boolean }[] };
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "cursor", removed: false }),
    ]);
  });

  test("respects --name", async () => {
    await mcpInstall({ client: ["cursor"], url: URL, name: "clerk-staging" });
    captured.clear();
    await mcpUninstall({ client: ["cursor"], name: "clerk-staging" });

    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(parsed.mcpServers?.["clerk-staging"]).toBeUndefined();
  });

  test("rejects an unknown --client id", async () => {
    await expect(mcpUninstall({ client: ["bogus"] })).rejects.toMatchObject({
      code: "mcp_client_not_supported",
    });
  });

  test("human mode: warns how to install when nothing is registered (no error)", async () => {
    mockIsAgent.mockReturnValue(false);
    await mcpUninstall({ client: ["cursor"] });
    expect(captured.err).toContain("clerk mcp install");
    expect(captured.err).not.toContain("Removing MCP entry"); // no success gutter for a no-op
  });

  test("human mode: prints reload next steps after a successful removal", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    mockIsAgent.mockReturnValue(false);
    captured.clear();
    await mcpUninstall({ client: ["cursor"] });
    expect(captured.err).toContain("Next steps");
    expect(captured.err).toContain("Reload Cursor");
  });

  test("human mode: removes the selected clients and leaves the rest", async () => {
    await mcpInstall({ client: ["cursor", "windsurf"], url: URL });
    mockIsAgent.mockReturnValue(false);
    mockMultiselect.mockResolvedValueOnce(["cursor"]); // select Cursor → remove Cursor
    captured.clear();

    await mcpUninstall({});

    expect(mockMultiselect).toHaveBeenCalledTimes(1);
    const cursorCfg = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(cursorCfg.mcpServers?.clerk).toBeUndefined();
    const windsurfCfg = JSON.parse(await readFile(join(cwd, ...WINDSURF_CONFIG), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(windsurfCfg.mcpServers.clerk).toBeDefined();
  });

  test("human mode: picker only lists clients that actually have the entry", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    mockIsAgent.mockReturnValue(false);
    mockMultiselect.mockResolvedValueOnce([]);
    captured.clear();

    await mcpUninstall({});

    const arg = mockMultiselect.mock.calls[0]![0] as { options: { value: string }[] };
    expect(arg.options.map((o) => o.value)).toEqual(["cursor"]);
  });

  test("human mode: selecting nothing removes nothing", async () => {
    await mcpInstall({ client: ["cursor", "windsurf"], url: URL });
    mockIsAgent.mockReturnValue(false);
    mockMultiselect.mockResolvedValueOnce([]);
    captured.clear();

    await mcpUninstall({});

    expect(captured.err).toContain("Nothing removed");
    const cursorCfg = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cursorCfg.mcpServers.clerk).toBeDefined();
  });

  test("human mode: --json alone still prompts the picker instead of removing everywhere", async () => {
    // `--json` only changes the output format; treating it as targeting would
    // let a human inspecting machine output wipe every client unprompted.
    await mcpInstall({ client: ["cursor", "windsurf"], url: URL });
    mockIsAgent.mockReturnValue(false);
    mockMultiselect.mockResolvedValueOnce(["cursor"]);
    captured.clear();

    await mcpUninstall({ json: true });

    expect(mockMultiselect).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(captured.out) as { results: { client: string }[] };
    expect(payload.results).toEqual([expect.objectContaining({ client: "cursor", removed: true })]);
    const windsurfCfg = JSON.parse(await readFile(join(cwd, ...WINDSURF_CONFIG), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(windsurfCfg.mcpServers.clerk).toBeDefined();
  });

  test("human mode: --all removes from every client without prompting", async () => {
    await mcpInstall({ client: ["cursor", "windsurf"], url: URL });
    mockIsAgent.mockReturnValue(false);
    captured.clear();

    await mcpUninstall({ all: true });

    expect(mockMultiselect).not.toHaveBeenCalled();
    const cursorCfg = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers?: Record<string, unknown>;
    };
    expect(cursorCfg.mcpServers?.clerk).toBeUndefined();
  });
});
