import type { findClientBinary, runClientCli } from "./cli-exec.ts";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as realOs from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import type { McpClient } from "./types.ts";

// Every client reads/writes under the user's home, so redirect homedir to a
// tmpdir (Bun's os.homedir() ignores $HOME) — registered before the clients
// load so paths.ts binds the redirected homedir.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));

// CLI-backed clients spawn their client's binary; stub the subprocess layer so
// the argv contract is asserted without real CLIs installed.
const mockRun = mock<typeof runClientCli>();
const mockWhich = mock<typeof findClientBinary>();
mock.module("./cli-exec.ts", () => ({
  findClientBinary: mockWhich,
  runClientCli: mockRun,
}));
afterAll(() => mock.restore());

const { claudeClient } = await import("./claude.ts");
const { cursorClient } = await import("./cursor.ts");
const { vscodeClient } = await import("./vscode.ts");
const { windsurfClient } = await import("./windsurf.ts");
const { geminiClient } = await import("./gemini.ts");
const { codexClient } = await import("./codex.ts");
const { opencodeClient } = await import("./opencode.ts");
const { openclawClient } = await import("./openclaw.ts");
const { warpClient } = await import("./warp.ts");
const { hermesClient } = await import("./hermes.ts");
const { vscodeUserDir } = await import("./paths.ts");

useCaptureLog();

const DEFAULT_URL = "https://mcp.clerk.com/mcp";

// The stdio bridge every client registers: it launches `clerk mcp run` (no URL
// in args — the URL is resolved at runtime).
const RUN_SHAPE = { command: "clerk", args: ["mcp", "run"] };

// Config paths are part of the public contract: `list`/`doctor` read them, and
// for the file-backed clients they're also where installs land.
const pathCases = [
  { name: "claude", client: claudeClient, expectedPath: () => join(mockHome, ".claude.json") },
  {
    name: "cursor",
    client: cursorClient,
    expectedPath: () => join(mockHome, ".cursor", "mcp.json"),
  },
  { name: "vscode", client: vscodeClient, expectedPath: () => join(vscodeUserDir(), "mcp.json") },
  {
    name: "windsurf",
    client: windsurfClient,
    expectedPath: () => join(mockHome, ".codeium", "windsurf", "mcp_config.json"),
  },
  {
    name: "gemini",
    client: geminiClient,
    expectedPath: () => join(mockHome, ".gemini", "settings.json"),
  },
  {
    name: "codex",
    client: codexClient,
    expectedPath: () => join(mockHome, ".codex", "config.toml"),
  },
  {
    name: "opencode",
    client: opencodeClient,
    // XDG_CONFIG_HOME is blanked in beforeEach, so the XDG fallback applies.
    expectedPath: () => join(mockHome, ".config", "opencode", "opencode.json"),
  },
  {
    name: "openclaw",
    client: openclawClient,
    expectedPath: () => join(mockHome, ".openclaw", "openclaw.json"),
  },
  {
    name: "warp",
    client: warpClient,
    expectedPath: () => join(mockHome, ".warp", ".mcp.json"),
  },
  {
    name: "hermes",
    client: hermesClient,
    expectedPath: () => join(mockHome, ".hermes", "config.yaml"),
  },
];

// File-backed clients: we write the entry ourselves (no usable registration
// CLI exists — opencode's `mcp add` is an interactive wizard, Warp has none).
const fileCases = [
  { name: "cursor", client: cursorClient, topKey: "mcpServers", shape: RUN_SHAPE },
  { name: "windsurf", client: windsurfClient, topKey: "mcpServers", shape: RUN_SHAPE },
  { name: "warp", client: warpClient, topKey: "mcpServers", shape: RUN_SHAPE },
  {
    name: "opencode",
    client: opencodeClient,
    topKey: "mcp",
    // opencode's stdio dialect: `type: "local"` and a single command array.
    shape: { type: "local", command: ["clerk", "mcp", "run"] },
  },
];

// CLI-backed clients: registration is delegated to the client's own CLI. The
// argv below (after the resolved binary path) is the public contract.
// `addOptions` is the subprocess options contract (e.g. Hermes gets its
// confirm-prompt answers piped to stdin).
type CliCase = {
  name: string;
  client: McpClient;
  binary: string;
  addArgv: string[];
  removeArgv: string[];
  addOptions?: { stdin: string };
};
const cliCases: CliCase[] = [
  {
    name: "claude",
    client: claudeClient,
    binary: "claude",
    addArgv: [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "clerk",
      "--",
      "clerk",
      "mcp",
      "run",
    ],
    removeArgv: ["mcp", "remove", "--scope", "user", "clerk"],
  },
  {
    name: "gemini",
    client: geminiClient,
    binary: "gemini",
    addArgv: [
      "mcp",
      "add",
      "--scope",
      "user",
      "--transport",
      "stdio",
      "clerk",
      "clerk",
      "mcp",
      "run",
    ],
    removeArgv: ["mcp", "remove", "--scope", "user", "clerk"],
  },
  {
    name: "codex",
    client: codexClient,
    binary: "codex",
    addArgv: ["mcp", "add", "clerk", "--", "clerk", "mcp", "run"],
    removeArgv: ["mcp", "remove", "clerk"],
  },
  {
    name: "openclaw",
    client: openclawClient,
    binary: "openclaw",
    // `--no-probe`: skip OpenClaw's test-connect on add — the hosted server
    // needs OAuth, so probing would fail an otherwise valid registration.
    addArgv: [
      "mcp",
      "add",
      "clerk",
      "--command",
      "clerk",
      "--arg",
      "mcp",
      "--arg",
      "run",
      "--no-probe",
    ],
    removeArgv: ["mcp", "unset", "clerk"],
  },
  {
    name: "hermes",
    client: hermesClient,
    binary: "hermes",
    // `--args` must be last: it swallows the rest of the argv.
    addArgv: ["mcp", "add", "clerk", "--command", "clerk", "--args", "mcp", "run"],
    // Hermes' add ends in a confirm prompt and cancels (exit 0!) on EOF, so
    // the answer is piped in.
    addOptions: { stdin: "y\n" },
    removeArgv: ["mcp", "remove", "clerk"],
  },
];

const VSCODE_ADD_JSON = JSON.stringify({ name: "clerk", type: "stdio", ...RUN_SHAPE });

describe("client contracts (homedir redirected)", () => {
  let origXdgConfigHome: string | undefined;
  let origAppData: string | undefined;

  beforeEach(async () => {
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-clients-"));
    origXdgConfigHome = process.env.XDG_CONFIG_HOME;
    origAppData = process.env.APPDATA;
    process.env.XDG_CONFIG_HOME = "";
    process.env.APPDATA = "";
    mockWhich.mockImplementation((binary: string) => `/fake/bin/${binary}`);
    mockRun.mockResolvedValue({ exitCode: 0, stdout: "", stderr: "" });
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
    mockWhich.mockReset();
    mockRun.mockReset();
  });

  test.each(pathCases)(
    "$name is user-scoped at its documented path",
    ({ client, expectedPath }) => {
      expect(client.scope).toBe("user");
      expect(client.configPath("/ignored")).toBe(expectedPath());
    },
  );

  test.each(fileCases)(
    "$name writes the documented entry shape",
    async ({ client, topKey, shape }) => {
      await client.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored");
      const parsed = JSON.parse(await readFile(client.configPath("/ignored"), "utf8")) as Record<
        string,
        Record<string, unknown>
      >;
      expect(parsed[topKey]?.clerk).toEqual(shape);
    },
  );

  test.each(cliCases)(
    "$name registers through its own CLI",
    async ({ client, binary, addArgv, addOptions }) => {
      // Seed the entry so post-add verification (hermes) sees it saved; the
      // pre-clean remove this triggers is asserted separately.
      await writeClientEntry(client.configPath("/ignored"));
      const result = await client.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored");
      expect(result.status).toBe("installed");
      if (addOptions) {
        expect(mockRun).toHaveBeenCalledWith([`/fake/bin/${binary}`, ...addArgv], addOptions);
      } else {
        expect(mockRun).toHaveBeenCalledWith([`/fake/bin/${binary}`, ...addArgv]);
      }
    },
  );

  test.each(cliCases)(
    "$name removes through its own CLI",
    async ({ client, binary, removeArgv }) => {
      // Pre-write the entry (as the client's CLI would have) so presence checks pass.
      const configPath = client.configPath("/ignored");
      await writeClientEntry(configPath);
      // Simulate the CLI mutating its own config — the factory re-reads it
      // after a successful remove and refuses to report a phantom removal.
      mockRun.mockImplementation(async () => {
        await rm(configPath, { force: true });
        return { exitCode: 0, stdout: "", stderr: "" };
      });
      const result = await client.remove("clerk", "/ignored");
      expect(result.removed).toBe(true);
      expect(mockRun).toHaveBeenCalledWith([`/fake/bin/${binary}`, ...removeArgv]);
    },
  );

  test.each(cliCases)(
    "$name detects via its binary on PATH, not the config dir",
    async ({ client, binary }) => {
      expect(await client.detect("/ignored")).toBe(true);
      expect(mockWhich).toHaveBeenCalledWith(binary);
      mockWhich.mockReturnValue(null);
      expect(await client.detect("/ignored")).toBe(false);
    },
  );

  test("vscode registers through `code --add-mcp` with the entry JSON", async () => {
    const result = await vscodeClient.upsert({ name: "clerk", url: DEFAULT_URL }, "/ignored");
    expect(result.status).toBe("installed");
    expect(mockRun).toHaveBeenCalledWith(["/fake/bin/code", "--add-mcp", VSCODE_ADD_JSON]);
  });

  test("vscode removes by editing its mcp.json (no removal CLI exists)", async () => {
    const configPath = vscodeClient.configPath("/ignored");
    await mkdir(join(vscodeUserDir()), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({ servers: { clerk: { type: "stdio", ...RUN_SHAPE } } }),
    );
    const result = await vscodeClient.remove("clerk", "/ignored");
    expect(result.removed).toBe(true);
    expect(mockRun).not.toHaveBeenCalled();
    const parsed = JSON.parse(await readFile(configPath, "utf8")) as { servers?: unknown };
    expect(parsed.servers).toBeUndefined();
  });

  test("opencode lists both its local (bridge) and remote (clerk-hosted) dialects", async () => {
    const configPath = opencodeClient.configPath("/ignored");
    await mkdir(join(configPath, ".."), { recursive: true });
    await writeFile(
      configPath,
      JSON.stringify({
        mcp: {
          clerk: { type: "local", command: ["clerk", "mcp", "run"] },
          hosted: { type: "remote", url: DEFAULT_URL },
          unrelated: { type: "remote", url: "https://example.com/mcp" },
        },
      }),
    );
    const entries = await opencodeClient.list("/ignored");
    expect(entries.map((e) => e.name).sort()).toEqual(["clerk", "hosted"]);
    expect(entries.every((e) => e.url === DEFAULT_URL)).toBe(true);
  });

  test("`copilot` resolves to the same client as `vscode`", async () => {
    const { resolveClients } = await import("../shared.ts");
    expect(resolveClients(["copilot"])).toEqual([vscodeClient]);
    expect(resolveClients(["copilot"])).toEqual(resolveClients(["vscode"]));
  });

  test("resolveClients dedupes an alias and its canonical id to one client", async () => {
    const { resolveClients } = await import("../shared.ts");
    expect(resolveClients(["copilot", "vscode"])).toEqual([vscodeClient]);
    expect(resolveClients(["cursor", "cursor"])).toEqual([cursorClient]);
  });
});

async function writeClientEntry(configPath: string): Promise<void> {
  const dir = join(configPath, "..");
  await mkdir(dir, { recursive: true });
  if (configPath.endsWith(".toml")) {
    await writeFile(configPath, '[mcp_servers.clerk]\ncommand = "clerk"\nargs = ["mcp", "run"]\n');
    return;
  }
  if (configPath.endsWith("config.yaml")) {
    await writeFile(
      configPath,
      "mcp_servers:\n  clerk:\n    command: clerk\n    args: [mcp, run]\n",
    );
    return;
  }
  if (configPath.endsWith("openclaw.json")) {
    await writeFile(configPath, JSON.stringify({ mcp: { servers: { clerk: RUN_SHAPE } } }));
    return;
  }
  await writeFile(configPath, JSON.stringify({ mcpServers: { clerk: RUN_SHAPE } }));
}
