import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
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
// install writes (read back by list) stay isolated to the test.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));

const { mcpInstall } = await import("./install.ts");
const { mcpList } = await import("./list.ts");

const URL = "https://mcp.clerk.com/mcp";

describe("mcp list", () => {
  const captured = useCaptureLog();
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-list-"));
    mockHome = cwd;
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(true);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    mockIsAgent.mockReset();
  });

  test("returns an empty JSON array when no clients have entries", async () => {
    await mcpList({});
    expect(JSON.parse(captured.out)).toEqual([]);
  });

  test("returns the cursor entry after install", async () => {
    await mcpInstall({ client: ["cursor"], url: URL });
    captured.clear();
    await mcpList({});
    const payload = JSON.parse(captured.out) as {
      client: string;
      name: string;
      url: string;
    }[];
    expect(payload).toEqual([
      expect.objectContaining({ client: "cursor", name: "clerk", url: URL }),
    ]);
  });

  test("human-mode empty state writes the hint to stderr, nothing to stdout", async () => {
    mockIsAgent.mockReturnValue(false);
    await mcpList({});
    expect(captured.out).toBe("");
    expect(captured.err).toContain("No Clerk MCP entries");
  });

  test("human-mode prints the formatted table to stdout after an install", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"], url: URL });
    mockIsAgent.mockReturnValue(false);
    captured.clear();
    await mcpList({});

    expect(captured.out).toContain("cursor");
    expect(captured.out).toContain("clerk");
    expect(captured.out).toContain(URL);
    expect(captured.err).toContain("1 entry");
    expect(captured.err).toContain("Next steps:");
    expect(captured.err).toContain("clerk doctor");
  });
});
