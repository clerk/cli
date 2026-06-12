import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
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

const { mcpInstall } = await import("./install.ts");
const { mcpUninstall } = await import("./uninstall.ts");

const URL = "https://mcp.clerk.com/mcp";

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
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    mockIsAgent.mockReset();
    mockMultiselect.mockReset();
  });

  test("removes the entry an install-uninstall round-trip leaves no trace under mcpServers", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    captured.clear();
    await mcpUninstall({ client: ["cursor"] });

    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers.clerk).toBeUndefined();
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
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers["clerk-staging"]).toBeUndefined();
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
    await mcpInstall({ client: ["cursor", "claude"], url: URL });
    mockIsAgent.mockReturnValue(false);
    mockMultiselect.mockResolvedValueOnce(["cursor"]); // select Cursor → remove Cursor
    captured.clear();

    await mcpUninstall({});

    expect(mockMultiselect).toHaveBeenCalledTimes(1);
    const cursorCfg = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cursorCfg.mcpServers.clerk).toBeUndefined();
    const claudeCfg = JSON.parse(await readFile(join(cwd, ".claude.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(claudeCfg.mcpServers.clerk).toBeDefined();
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
    await mcpInstall({ client: ["cursor", "claude"], url: URL });
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

  test("human mode: --all removes from every client without prompting", async () => {
    await mcpInstall({ client: ["cursor", "claude"], url: URL });
    mockIsAgent.mockReturnValue(false);
    captured.clear();

    await mcpUninstall({ all: true });

    expect(mockMultiselect).not.toHaveBeenCalled();
    const cursorCfg = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(cursorCfg.mcpServers.clerk).toBeUndefined();
  });
});
