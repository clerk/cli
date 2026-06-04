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

  test("throws MCP_NOT_INSTALLED when nothing is registered", async () => {
    await expect(mcpUninstall({ client: ["cursor"] })).rejects.toMatchObject({
      code: "mcp_not_installed",
    });
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

  test("human mode: nothing-to-remove throws without a contradictory success outro", async () => {
    mockIsAgent.mockReturnValue(false);
    await expect(mcpUninstall({ client: ["cursor"] })).rejects.toMatchObject({
      code: "mcp_not_installed",
    });
    expect(captured.err).not.toContain("Nothing to remove");
  });

  test("human mode: prints reload next steps after a successful removal", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    mockIsAgent.mockReturnValue(false);
    captured.clear();
    await mcpUninstall({ client: ["cursor"] });
    expect(captured.err).toContain("Next steps:");
    expect(captured.err).toContain("Reload Cursor");
  });
});
