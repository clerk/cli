import type { findClientBinary, runClientCli } from "./cli-exec.ts";
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as realOs from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../../../test/lib/stubs.ts";

// Redirect homedir so the synthetic base client writes into a tmpdir.
let mockHome = realOs.tmpdir();
mock.module("node:os", () => ({ ...realOs, homedir: () => mockHome }));

// Stub the subprocess layer: no real client CLIs are spawned in unit tests.
const mockRun = mock<typeof runClientCli>();
const mockWhich = mock<typeof findClientBinary>();
mock.module("./cli-exec.ts", () => ({
  findClientBinary: mockWhich,
  runClientCli: mockRun,
}));
afterAll(() => mock.restore());

const { makeJsonClient } = await import("./make-client.ts");
const { makeCliClient } = await import("./make-cli-client.ts");

useCaptureLog();

const CLERK_URL = "https://mcp.clerk.com/mcp";
const BIN_PATH = "/fake/bin/fakecli";

function ok() {
  return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
}

function fail(stderr: string) {
  return Promise.resolve({ exitCode: 1, stdout: "", stderr });
}

// A synthetic file-backed base standing in for the real clients, so the factory
// is tested in isolation from any specific client's path/encode details.
function makeBase() {
  return makeJsonClient({
    id: "claude",
    displayName: "Fake Client",
    scope: "user",
    activation: "Restart Fake Client.",
    topKey: "mcpServers",
    encode: () => ({ command: "clerk", args: ["mcp", "run"] }),
    extractUrl: (d) =>
      typeof d === "object" && d !== null && "url" in d ? String(d.url) : CLERK_URL,
    configPath: () => join(mockHome, ".fake", "config.json"),
    detect: () => Promise.resolve(true),
  });
}

function makeClient(
  overrides: {
    removeArgs?: (name: string) => string[];
    addStdin?: string;
    verifyAdd?: boolean;
  } = {},
) {
  const spec = {
    base: makeBase(),
    binary: "fakecli",
    installHint: "Install it from https://example.com/fakecli.",
    addArgs: (name: string) => ["mcp", "add", name],
    ...(overrides.addStdin !== undefined ? { addStdin: overrides.addStdin } : {}),
    ...(overrides.verifyAdd !== undefined ? { verifyAdd: overrides.verifyAdd } : {}),
  };
  // An explicit `removeArgs: undefined` override models VS Code's add-only CLI.
  if ("removeArgs" in overrides) {
    return overrides.removeArgs
      ? makeCliClient({ ...spec, removeArgs: overrides.removeArgs })
      : makeCliClient(spec);
  }
  return makeCliClient({ ...spec, removeArgs: (name: string) => ["mcp", "remove", name] });
}

async function writeBaseConfig(entryName = "clerk"): Promise<string> {
  const dir = join(mockHome, ".fake");
  await mkdir(dir, { recursive: true });
  const path = join(dir, "config.json");
  await writeFile(
    path,
    JSON.stringify({ mcpServers: { [entryName]: { command: "clerk", args: ["mcp", "run"] } } }),
  );
  return path;
}

describe("makeCliClient", () => {
  beforeEach(async () => {
    mockHome = await mkdtemp(join(realOs.tmpdir(), "clerk-mcp-cli-client-"));
    mockWhich.mockReturnValue(BIN_PATH);
    mockRun.mockImplementation(() => ok());
  });

  afterEach(async () => {
    await rm(mockHome, { recursive: true, force: true });
    mockWhich.mockReset();
    mockRun.mockReset();
  });

  test("delegates identity, configPath, and list to the base client", async () => {
    const client = makeClient();
    expect(client.id).toBe("claude");
    expect(client.displayName).toBe("Fake Client");
    expect(client.scope).toBe("user");
    expect(client.configPath("/ignored")).toBe(join(mockHome, ".fake", "config.json"));

    await writeBaseConfig();
    const entries = await client.list("/ignored");
    expect(entries.map((e) => e.name)).toEqual(["clerk"]);
  });

  describe("detect", () => {
    test("is true when the binary resolves on PATH", async () => {
      const client = makeClient();
      expect(await client.detect("/ignored")).toBe(true);
      expect(mockWhich).toHaveBeenCalledWith("fakecli");
    });

    test("is false when the binary is missing, even if the config dir exists", async () => {
      await writeBaseConfig();
      mockWhich.mockReturnValue(null);
      const client = makeClient();
      expect(await client.detect("/ignored")).toBe(false);
    });
  });

  describe("upsert", () => {
    test("rejects with mcp_client_cli_not_found when the binary is missing", async () => {
      mockWhich.mockReturnValue(null);
      const client = makeClient();
      const attempt = client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      // The docs page carries per-client manual setup — the fallback when we
      // can't drive the client's CLI.
      await expect(attempt).rejects.toMatchObject({
        code: "mcp_client_cli_not_found",
        docsUrl: expect.stringContaining("https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server"),
      });
      await expect(client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored")).rejects.toThrow(
        /fakecli/,
      );
      expect(mockRun).not.toHaveBeenCalled();
    });

    test("includes the install hint in the not-found error", async () => {
      mockWhich.mockReturnValue(null);
      const client = makeClient();
      await expect(client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored")).rejects.toThrow(
        /https:\/\/example.com\/fakecli/,
      );
    });

    test("runs only the add command when no entry exists yet", async () => {
      const client = makeClient();
      const result = await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      expect(result).toEqual({
        client: "claude",
        configPath: join(mockHome, ".fake", "config.json"),
        status: "installed",
      });
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenCalledWith([BIN_PATH, "mcp", "add", "clerk"]);
    });

    test("removes before adding when the entry already exists (remove-then-add)", async () => {
      await writeBaseConfig();
      const client = makeClient();
      await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      expect(mockRun.mock.calls.map((c) => c[0])).toEqual([
        [BIN_PATH, "mcp", "remove", "clerk"],
        [BIN_PATH, "mcp", "add", "clerk"],
      ]);
    });

    test("ignores a failing best-effort remove and still adds", async () => {
      await writeBaseConfig();
      mockRun
        .mockImplementationOnce(() => fail("no such server"))
        .mockImplementationOnce(() => ok());
      const client = makeClient();
      const result = await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      expect(result.status).toBe("installed");
      expect(mockRun).toHaveBeenCalledTimes(2);
    });

    test("rejects with mcp_client_cli_failed and surfaces stderr when add exits non-zero", async () => {
      mockRun.mockImplementation(() => fail("boom: flag not recognized"));
      const client = makeClient();
      const attempt = client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      await expect(attempt).rejects.toMatchObject({
        code: "mcp_client_cli_failed",
        docsUrl: expect.stringContaining("https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server"),
      });
      await expect(client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored")).rejects.toThrow(
        /boom: flag not recognized/,
      );
    });

    test("still runs add when the base config is unreadable (the CLI owns its format)", async () => {
      const dir = join(mockHome, ".fake");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.json"), "{ not json");
      const client = makeClient();
      const result = await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      expect(result.status).toBe("installed");
      expect(mockRun).toHaveBeenCalledWith([BIN_PATH, "mcp", "add", "clerk"]);
    });

    test("pipes addStdin to the CLI add (for CLIs whose add ends in a prompt)", async () => {
      const client = makeClient({ addStdin: "y\n" });
      await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      expect(mockRun).toHaveBeenCalledWith([BIN_PATH, "mcp", "add", "clerk"], { stdin: "y\n" });
    });

    test("verifyAdd rejects when the CLI exits 0 without saving the entry", async () => {
      // Hermes' `mcp add` cancels its final prompt on unexpected input/EOF and
      // still exits 0 — a lying exit code. verifyAdd re-reads the config and
      // turns that silent no-op into a real failure.
      const client = makeClient({ verifyAdd: true });
      await expect(
        client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored"),
      ).rejects.toMatchObject({
        code: "mcp_client_cli_failed",
        docsUrl: expect.stringContaining("https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server"),
      });
    });

    test("verifyAdd passes when the entry landed in the config", async () => {
      mockRun.mockImplementation(async (argv: string[]) => {
        // Simulate the client CLI writing its own config on add.
        if (argv.includes("add")) await writeBaseConfig();
        return ok();
      });
      const client = makeClient({ verifyAdd: true });
      const result = await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      expect(result.status).toBe("installed");
    });

    test("verifyAdd trusts the CLI when the config is unreadable", async () => {
      const dir = join(mockHome, ".fake");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.json"), "{ not json");
      const client = makeClient({ verifyAdd: true });
      const result = await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      expect(result.status).toBe("installed");
    });

    test("falls back to a file-based pre-clean when the CLI has no remove command", async () => {
      // VS Code's case: `code --add-mcp` exists, but there is no removal CLI.
      const path = await writeBaseConfig();
      const client = makeClient({ removeArgs: undefined });
      await client.upsert({ name: "clerk", url: CLERK_URL }, "/ignored");
      // Old entry cleaned from the file, then the CLI add ran.
      const written = JSON.parse(await readFile(path, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(written.mcpServers?.clerk).toBeUndefined();
      expect(mockRun).toHaveBeenCalledTimes(1);
      expect(mockRun).toHaveBeenCalledWith([BIN_PATH, "mcp", "add", "clerk"]);
    });
  });

  describe("remove", () => {
    test("reports removed:false without invoking the CLI when the entry is absent", async () => {
      const client = makeClient();
      const result = await client.remove("clerk", "/ignored");
      expect(result).toEqual({
        client: "claude",
        configPath: join(mockHome, ".fake", "config.json"),
        removed: false,
      });
      expect(mockRun).not.toHaveBeenCalled();
    });

    test("runs the CLI remove when the entry is present", async () => {
      await writeBaseConfig();
      const client = makeClient();
      const result = await client.remove("clerk", "/ignored");
      expect(result.removed).toBe(true);
      expect(mockRun).toHaveBeenCalledWith([BIN_PATH, "mcp", "remove", "clerk"]);
    });

    test("rejects with mcp_client_cli_not_found when the binary is missing and the entry is present", async () => {
      await writeBaseConfig();
      mockWhich.mockReturnValue(null);
      const client = makeClient();
      await expect(client.remove("clerk", "/ignored")).rejects.toMatchObject({
        code: "mcp_client_cli_not_found",
      });
    });

    test("rejects with mcp_client_cli_failed when the CLI remove exits non-zero", async () => {
      await writeBaseConfig();
      mockRun.mockImplementation(() => fail("cannot remove"));
      const client = makeClient();
      await expect(client.remove("clerk", "/ignored")).rejects.toMatchObject({
        code: "mcp_client_cli_failed",
      });
    });

    test("attempts the CLI remove when the config is unreadable (presence unknown)", async () => {
      const dir = join(mockHome, ".fake");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "config.json"), "{ not json");
      const client = makeClient();
      const result = await client.remove("clerk", "/ignored");
      expect(result.removed).toBe(true);
      expect(mockRun).toHaveBeenCalledWith([BIN_PATH, "mcp", "remove", "clerk"]);
    });

    test("delegates entirely to the base file remove when the CLI has no remove command", async () => {
      const path = await writeBaseConfig();
      const client = makeClient({ removeArgs: undefined });
      const result = await client.remove("clerk", "/ignored");
      expect(result.removed).toBe(true);
      expect(mockRun).not.toHaveBeenCalled();
      const written = JSON.parse(await readFile(path, "utf8")) as {
        mcpServers?: Record<string, unknown>;
      };
      expect(written.mcpServers?.clerk).toBeUndefined();
    });
  });
});
