import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import * as realOs from "node:os";
import { join } from "node:path";
import { captureUi, useCaptureLog } from "../../test/lib/stubs.ts";

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
  let uiCapture: ReturnType<typeof captureUi>;
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-list-"));
    mockHome = cwd;
    process.chdir(cwd);
    uiCapture = captureUi();
    uiCapture.install();
    mockIsAgent.mockReturnValue(true);
  });

  afterEach(async () => {
    uiCapture.teardown();
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

  test("human-mode empty state shows the hint on the prompt rail, nothing to stdout", async () => {
    mockIsAgent.mockReturnValue(false);
    await mcpList({});
    expect(captured.out).toBe("");
    expect(uiCapture.out).toContain("No Clerk MCP entries");
  });

  test("human-mode renders the table and next steps after an install", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"], url: URL });
    mockIsAgent.mockReturnValue(false);
    captured.clear();
    await mcpList({});

    // Table, count, and the outro next-steps all render on the clack prompt
    // rail; with captureUi installed, intro/outro write to that stream too.
    expect(uiCapture.out).toContain("cursor");
    expect(uiCapture.out).toContain("clerk");
    expect(uiCapture.out).toContain(URL);
    expect(uiCapture.out).toContain("1 entry");
    expect(uiCapture.out).toContain("Next steps");
    expect(uiCapture.out).toContain("clerk doctor");
  });
});
