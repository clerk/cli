import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import * as realOs from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

// Every client writes under the user's home now, so redirect homedir to a
// tmpdir (Bun's os.homedir() ignores $HOME) — registered before the clients
// load so paths.ts binds the redirected homedir.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));
afterAll(() => mock.restore());

const { claudeClient } = await import("./claude.ts");
const { cursorClient } = await import("./cursor.ts");
const { vscodeClient } = await import("./vscode.ts");
const { windsurfClient } = await import("./windsurf.ts");
const { geminiClient } = await import("./gemini.ts");
const { vscodeUserDir } = await import("./paths.ts");

useCaptureLog();

const URL = "https://mcp.clerk.com/mcp";

// Path + entry shape are part of the public contract: each client targets a
// specific user-global config file and encodes the server its own way.
const cases = [
  {
    name: "claude",
    client: claudeClient,
    expectedPath: () => join(mockHome, ".claude.json"),
    topKey: "mcpServers",
    shape: { type: "http", url: URL },
  },
  {
    name: "cursor",
    client: cursorClient,
    expectedPath: () => join(mockHome, ".cursor", "mcp.json"),
    topKey: "mcpServers",
    shape: { url: URL },
  },
  {
    name: "vscode",
    client: vscodeClient,
    expectedPath: () => join(vscodeUserDir(), "mcp.json"),
    topKey: "servers",
    shape: { type: "http", url: URL },
  },
  {
    name: "windsurf",
    client: windsurfClient,
    expectedPath: () => join(mockHome, ".codeium", "windsurf", "mcp_config.json"),
    topKey: "mcpServers",
    shape: { serverUrl: URL },
  },
  {
    name: "gemini",
    client: geminiClient,
    expectedPath: () => join(mockHome, ".gemini", "settings.json"),
    topKey: "mcpServers",
    shape: { command: "npx", args: ["-y", "mcp-remote", URL] },
  },
];

describe("client config paths + encoded shapes (homedir redirected)", () => {
  let origXdgConfigHome: string | undefined;
  let origAppData: string | undefined;

  beforeEach(async () => {
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-clients-"));
    origXdgConfigHome = process.env.XDG_CONFIG_HOME;
    origAppData = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = "";
    process.env.APPDATA = "";
  });

  afterEach(async () => {
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
    await rm(mockHome, { recursive: true, force: true });
  });

  test.each(cases)("$name is user-scoped at its documented path", ({ client, expectedPath }) => {
    expect(client.scope).toBe("user");
    expect(client.configPath("/ignored")).toBe(expectedPath());
  });

  test.each(cases)("$name writes the documented entry shape", async ({ client, topKey, shape }) => {
    await client.upsert({ name: "clerk", url: URL }, "/ignored", false);
    const parsed = JSON.parse(await readFile(client.configPath("/ignored"), "utf8")) as Record<
      string,
      Record<string, unknown>
    >;
    expect(parsed[topKey]?.clerk).toEqual(shape);
  });

  test("vscode writes under `servers`, not `mcpServers`", async () => {
    await vscodeClient.upsert({ name: "clerk", url: URL }, "/ignored", false);
    const parsed = JSON.parse(await readFile(vscodeClient.configPath("/ignored"), "utf8")) as {
      servers?: unknown;
      mcpServers?: unknown;
    };
    expect(parsed.servers).toBeDefined();
    expect(parsed.mcpServers).toBeUndefined();
  });
});
