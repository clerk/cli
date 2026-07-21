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

// All clients write under the user's home now. Redirect homedir to the same
// tmpdir we use as cwd (Bun's os.homedir() ignores $HOME) so writes stay
// isolated and the `join(cwd, ...)` assertions below still resolve.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));

const mockMultiselect = mock();
mock.module("../../lib/prompts.ts", () => ({
  multiselect: (...args: unknown[]) => mockMultiselect(...args),
}));

// CLI-backed clients (claude, gemini, codex, vscode, openclaw, hermes) delegate registration to
// their own CLI — stub the subprocess layer so no real binaries are needed.
const mockRun = mock<typeof runClientCli>();
const mockWhich = mock<typeof findClientBinary>();
mock.module("./clients/cli-exec.ts", () => ({
  findClientBinary: mockWhich,
  runClientCli: mockRun,
}));
afterAll(() => mock.restore());

const { mcpInstall } = await import("./install.ts");

// The URL the default env profile resolves to.
const DEFAULT_URL = "https://mcp.clerk.com/mcp";
// A foreign URL not in the default profile — used to simulate a pre-existing foreign entry.
const FOREIGN_URL = "http://localhost:8787/mcp";

// The entry shape written by the current CLI — no URL in args.
const CURRENT_SHAPE = { command: "clerk", args: ["mcp", "run"] };

describe("mcp install", () => {
  const captured = useCaptureLog();
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-install-"));
    mockHome = cwd;
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(false);
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

  test.each([
    // The name is spliced into client CLI argv (and through cmd.exe /c on
    // Windows, where `&` is a live operator) and used as a config key.
    ["shell metacharacters", "clerk & calc.exe"],
    ["a flag lookalike", "--scope"],
    ["a leading dash", "-x"],
    ["an empty string", ""],
    ["an overlong name", "a".repeat(65)],
  ])("rejects a --name with %s as a usage error", async (_label, name) => {
    await expect(mcpInstall({ client: ["cursor"], name })).rejects.toMatchObject({
      code: "usage_error",
    });
    expect(mockRun).not.toHaveBeenCalled();
  });

  test("accepts a --name with dashes and underscores", async () => {
    await mcpInstall({ client: ["cursor"], name: "clerk_dev-2" });
    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers["clerk_dev-2"]).toEqual(CURRENT_SHAPE);
  });

  test("writes the Cursor config when --client cursor is passed", async () => {
    await mcpInstall({ client: ["cursor"] });

    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: { clerk: unknown };
    };
    expect(parsed.mcpServers.clerk).toEqual(CURRENT_SHAPE);
  });

  test("delegates Claude Code registration to `claude mcp add`", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["claude"] });

    const argv = mockRun.mock.calls.at(-1)?.[0] as string[];
    expect(argv[0]).toBe("/fake/bin/claude");
    expect(argv).toContain("add");
    // No file written by us — the CLI owns the config.
    await expect(readFile(join(cwd, ".claude.json"), "utf8")).rejects.toThrow();
  });

  test("fails the client when its CLI binary is not on PATH (no file fallback)", async () => {
    mockWhich.mockReturnValue(null);
    await expect(mcpInstall({ client: ["claude"] })).rejects.toMatchObject({
      code: "mcp_client_cli_not_found",
    });
    expect(mockRun).not.toHaveBeenCalled();
    // settleClients prefixes the display name on warn lines; the error message
    // itself must not repeat it ("Claude Code: Claude Code: …").
    expect(captured.err).toContain("Claude Code:");
    expect(captured.err).not.toContain("Claude Code: Claude Code:");
  });

  test("emits JSON to stdout in agent mode and skips intro/outro", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });

    const payload = JSON.parse(captured.out) as {
      url: string;
      name: string;
      results: { client: string; status: string }[];
    };
    expect(payload.url).toBe(DEFAULT_URL);
    expect(payload.name).toBe("clerk");
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "cursor", status: "installed" }),
    ]);
    expect(captured.err).not.toContain("┌"); // intro suppressed in agent mode
  });

  test("--json forces JSON output even in human mode", async () => {
    await mcpInstall({ client: ["cursor"], json: true });
    expect(() => JSON.parse(captured.out)).not.toThrow();
  });

  test("human mode: --json alone still prompts the picker instead of installing everywhere", async () => {
    // `--json` is an output format, not a targeting choice — only agent mode
    // (or --client/--all) skips the picker.
    mockMultiselect.mockResolvedValueOnce(["cursor"]);

    await mcpInstall({ json: true });

    expect(mockMultiselect).toHaveBeenCalledTimes(1);
    const payload = JSON.parse(captured.out) as { results: { client: string }[] };
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "cursor", status: "installed" }),
    ]);
  });

  test("json mode: emits the failure envelope and sets a non-zero exit code when every client fails", async () => {
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");
    const originalExitCode = process.exitCode;
    try {
      await mcpInstall({ client: ["cursor"], json: true });

      // The envelope (with `failures`) still lands on stdout — exactly the
      // case a machine consumer needs it — and the exit code carries the failure.
      const payload = JSON.parse(captured.out) as {
        results: unknown[];
        failures: { client: string }[];
      };
      expect(payload.results).toEqual([]);
      expect(payload.failures).toEqual([expect.objectContaining({ client: "cursor" })]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = originalExitCode;
    }
  });

  test("re-install is idempotent and reports installed again", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });
    captured.clear();
    await mcpInstall({ client: ["cursor"] });

    const payload = JSON.parse(captured.out) as {
      results: { status: string }[];
    };
    expect(payload.results[0]?.status).toBe("installed");
  });

  test("overwrites an existing entry pointing at a foreign server (always converges)", async () => {
    // Pre-write a legacy bare-URL entry pointing at a non-Clerk server.
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(
      join(cwd, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { clerk: { url: FOREIGN_URL } } }),
    );

    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });

    const payload = JSON.parse(captured.out) as {
      results: { status: string }[];
    };
    expect(payload.results[0]?.status).toBe("installed");
    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: { clerk: unknown };
    };
    expect(parsed.mcpServers.clerk).toEqual(CURRENT_SHAPE);
  });

  test("uses --name to customize the entry key", async () => {
    await mcpInstall({ client: ["cursor"], name: "clerk-staging" });
    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect(parsed.mcpServers["clerk-staging"]).toEqual(CURRENT_SHAPE);
    expect(parsed.mcpServers.clerk).toBeUndefined();
  });

  test("passes --name through to the client CLI argv", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["claude"], name: "clerk-staging" });
    const argv = mockRun.mock.calls.at(-1)?.[0] as string[];
    expect(argv).toContain("clerk-staging");
  });

  test("reports the resolved URL in JSON output", async () => {
    // Default production profile has mcpUrl=https://mcp.clerk.com/mcp.
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });
    const payload = JSON.parse(captured.out) as { url: string };
    expect(payload.url).toBe(DEFAULT_URL);
  });

  test("falls back to Clerk's hosted MCP URL when the active profile has no mcpUrl", async () => {
    // Reproduces the published snapshot: a build-time env profile that omits
    // `mcpUrl`. `getMcpUrl()` must still resolve to the hosted server so a bare
    // `clerk mcp install` works without any profile setup.
    await writeFile(
      join(cwd, ".env-profiles.json"),
      JSON.stringify({
        production: {
          oauthClientId: "ins_test",
          oauthBaseUrl: "https://clerk.clerk.com",
          platformApiUrl: "https://api.clerk.com",
          backendApiUrl: "https://api.clerk.dev",
        },
      }),
    );
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });
    const payload = JSON.parse(captured.out) as { url: string };
    expect(payload.url).toBe(DEFAULT_URL);
  });

  test.each([
    ["file:///etc/passwd"],
    ["data:text/plain,clerk"],
    ["javascript:alert(1)"],
    ["ftp://example.com/mcp"],
  ])("rejects non-http(s) CLERK_MCP_URL: %s", async (badUrl) => {
    await expect(mcpInstall({ client: ["cursor"], url: badUrl })).rejects.toMatchObject({
      code: "mcp_url_required",
    });
  });

  test("rejects unparseable URL", async () => {
    await expect(mcpInstall({ client: ["cursor"], url: "not a url" })).rejects.toMatchObject({
      code: "mcp_url_required",
    });
  });

  test("rejects a URL with embedded credentials", async () => {
    await expect(
      mcpInstall({ client: ["cursor"], url: "https://token@mcp.clerk.com/mcp" }),
    ).rejects.toMatchObject({ code: "mcp_url_required" });
  });

  test("prints next steps after a human-mode install", async () => {
    await mcpInstall({ client: ["cursor"] });
    expect(captured.err).toContain("Next steps");
    expect(captured.err).toContain("Reload Cursor");
  });

  test("omits next steps from JSON output", async () => {
    await mcpInstall({ client: ["cursor"], json: true });
    expect(captured.err).not.toContain("Next steps");
  });

  test("rejects an unknown --client id", async () => {
    await expect(mcpInstall({ client: ["bogus"] })).rejects.toMatchObject({
      code: "mcp_client_not_supported",
    });
  });

  test("installs the healthy clients and warns when one config is corrupt", async () => {
    mockIsAgent.mockReturnValue(true);
    // Pre-corrupt Cursor's config; Windsurf's is absent (clean).
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");

    await mcpInstall({ client: ["cursor", "windsurf"] });

    const payload = JSON.parse(captured.out) as {
      results: { client: string; status: string }[];
      failures: { client: string; error: string }[];
    };
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "windsurf", status: "installed" }),
    ]);
    // The failed client is structurally visible to JSON/agent consumers, not
    // only as a free-text stderr warning.
    expect(payload.failures).toEqual([expect.objectContaining({ client: "cursor" })]);
    expect(captured.err).toContain("Cursor"); // per-client warning for the failure
  });

  test("reports a client CLI failure in the JSON failures array", async () => {
    mockIsAgent.mockReturnValue(true);
    mockRun.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "flag not recognized" });

    await mcpInstall({ client: ["claude", "cursor"] });

    const payload = JSON.parse(captured.out) as {
      results: { client: string }[];
      failures: { client: string; error: string }[];
    };
    expect(payload.results).toEqual([expect.objectContaining({ client: "cursor" })]);
    expect(payload.failures).toEqual([expect.objectContaining({ client: "claude" })]);
    expect(payload.failures[0]?.error).toContain("flag not recognized");
  });

  test("throws when every targeted client fails", async () => {
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");

    await expect(mcpInstall({ client: ["cursor"] })).rejects.toMatchObject({
      code: "mcp_client_config_invalid",
    });
    expect(captured.err).toContain("Cursor");
  });

  test("surfaces the client CLI's stderr when the add command fails", async () => {
    mockRun.mockResolvedValue({ exitCode: 1, stdout: "", stderr: "unexpected flag" });
    await expect(mcpInstall({ client: ["claude"] })).rejects.toMatchObject({
      code: "mcp_client_cli_failed",
    });
    expect(captured.err).toContain("unexpected flag");
  });
});
