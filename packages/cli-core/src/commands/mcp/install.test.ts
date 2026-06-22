import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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

const { mcpInstall } = await import("./install.ts");

// The URL the default env profile resolves to.
const DEFAULT_URL = "https://mcp.clerk.com/mcp";
// A foreign URL not in the default profile — used to simulate a conflict.
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
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    mockIsAgent.mockReset();
  });

  test("writes the Cursor config when --client cursor is passed", async () => {
    await mcpInstall({ client: ["cursor"] });

    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: { clerk: unknown };
    };
    expect(parsed.mcpServers.clerk).toEqual(CURRENT_SHAPE);
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
      expect.objectContaining({ client: "cursor", status: "added" }),
    ]);
    expect(captured.err).not.toContain("┌"); // intro suppressed in agent mode
  });

  test("--json forces JSON output even in human mode", async () => {
    await mcpInstall({ client: ["cursor"], json: true });
    expect(() => JSON.parse(captured.out)).not.toThrow();
  });

  test("returns `unchanged` on idempotent re-install", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });
    captured.clear();
    await mcpInstall({ client: ["cursor"] });

    const payload = JSON.parse(captured.out) as {
      results: { status: string }[];
    };
    expect(payload.results[0]?.status).toBe("unchanged");
  });

  test("skips with reason when existing entry points at a foreign server (no --force)", async () => {
    // Pre-write a legacy bare-URL entry pointing at a non-Clerk server.
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(
      join(cwd, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { clerk: { url: FOREIGN_URL } } }),
    );

    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });

    const payload = JSON.parse(captured.out) as {
      results: { status: string; reason?: string }[];
    };
    expect(payload.results[0]?.status).toBe("skipped");
    expect(payload.results[0]?.reason).toContain("--force");
  });

  test("overwrites a foreign-server entry with --force", async () => {
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(
      join(cwd, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { clerk: { url: FOREIGN_URL } } }),
    );

    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"], force: true });

    const payload = JSON.parse(captured.out) as {
      results: { status: string }[];
    };
    expect(payload.results[0]?.status).toBe("updated");
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

  test("does not print next steps when the entry was unchanged", async () => {
    await mcpInstall({ client: ["cursor"] });
    captured.clear();
    await mcpInstall({ client: ["cursor"] });
    expect(captured.err).not.toContain("Next steps");
  });

  test("rejects an unknown --client id", async () => {
    await expect(mcpInstall({ client: ["bogus"] })).rejects.toMatchObject({
      code: "mcp_client_not_supported",
    });
  });

  test("installs the healthy clients and warns when one config is corrupt", async () => {
    mockIsAgent.mockReturnValue(true);
    // Pre-corrupt Cursor's config; Claude Code's is absent (clean).
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");

    await mcpInstall({ client: ["cursor", "claude"] });

    const payload = JSON.parse(captured.out) as { results: { client: string; status: string }[] };
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "claude", status: "added" }),
    ]);
    expect(captured.err).toContain("Cursor"); // per-client warning for the failure
  });

  test("throws when every targeted client fails", async () => {
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");

    await expect(mcpInstall({ client: ["cursor"] })).rejects.toMatchObject({
      code: "mcp_client_config_invalid",
    });
    expect(captured.err).toContain("Cursor");
  });
});
