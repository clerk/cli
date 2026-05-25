import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useCaptureLog } from "../../test/lib/stubs.ts";

const mockIsAgent = mock();
mock.module("../../mode.ts", () => ({
  isAgent: (...args: unknown[]) => mockIsAgent(...args),
  isHuman: (...args: unknown[]) => !mockIsAgent(...args),
  setMode: () => {},
  getMode: () => (mockIsAgent() ? "agent" : "human"),
}));

const { mcpInstall } = await import("./install.ts");

const URL_A = "https://mcp.clerk.com/mcp";
const URL_B = "http://localhost:8787/mcp";

describe("mcp install", () => {
  const captured = useCaptureLog();
  let cwd: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    cwd = await mkdtemp(join(tmpdir(), "clerk-mcp-install-"));
    process.chdir(cwd);
    mockIsAgent.mockReturnValue(false);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    await rm(cwd, { recursive: true, force: true });
    mockIsAgent.mockReset();
  });

  test("writes the Cursor config when --client cursor is passed", async () => {
    await mcpInstall({ client: ["cursor"], url: URL_A });

    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: { clerk: { url: string } };
    };
    expect(parsed.mcpServers.clerk).toEqual({ url: URL_A });
  });

  test("emits JSON to stdout in agent mode and skips intro/outro", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"], url: URL_A });

    const payload = JSON.parse(captured.out) as {
      url: string;
      name: string;
      results: { client: string; status: string }[];
    };
    expect(payload.url).toBe(URL_A);
    expect(payload.name).toBe("clerk");
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "cursor", status: "added" }),
    ]);
    expect(captured.err).not.toContain("┌"); // intro suppressed in agent mode
  });

  test("--json forces JSON output even in human mode", async () => {
    await mcpInstall({ client: ["cursor"], url: URL_A, json: true });
    expect(() => JSON.parse(captured.out)).not.toThrow();
  });

  test("returns `unchanged` on idempotent re-install", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"], url: URL_A });
    captured.clear();
    await mcpInstall({ client: ["cursor"], url: URL_A });

    const payload = JSON.parse(captured.out) as {
      results: { status: string }[];
    };
    expect(payload.results[0]?.status).toBe("unchanged");
  });

  test("skips with reason on URL conflict without --force", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"], url: URL_A });
    captured.clear();
    await mcpInstall({ client: ["cursor"], url: URL_B });

    const payload = JSON.parse(captured.out) as {
      results: { status: string; reason?: string }[];
    };
    expect(payload.results[0]?.status).toBe("skipped");
    expect(payload.results[0]?.reason).toContain("--force");
  });

  test("overwrites on URL conflict with --force", async () => {
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"], url: URL_A });
    captured.clear();
    await mcpInstall({ client: ["cursor"], url: URL_B, force: true });

    const payload = JSON.parse(captured.out) as {
      results: { status: string }[];
    };
    expect(payload.results[0]?.status).toBe("updated");
    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: { clerk: { url: string } };
    };
    expect(parsed.mcpServers.clerk.url).toBe(URL_B);
  });

  test("uses --name to customize the entry key", async () => {
    await mcpInstall({ client: ["cursor"], url: URL_A, name: "clerk-staging" });
    const parsed = JSON.parse(await readFile(join(cwd, ".cursor", "mcp.json"), "utf8")) as {
      mcpServers: Record<string, { url: string }>;
    };
    expect(parsed.mcpServers["clerk-staging"]).toEqual({ url: URL_A });
    expect(parsed.mcpServers.clerk).toBeUndefined();
  });

  test("uses the active env profile URL when --url is not given", async () => {
    // Default production profile has mcpUrl=https://mcp.clerk.com/mcp.
    mockIsAgent.mockReturnValue(true);
    await mcpInstall({ client: ["cursor"] });
    const payload = JSON.parse(captured.out) as { url: string };
    expect(payload.url).toBe("https://mcp.clerk.com/mcp");
  });

  test.each([
    ["file:///etc/passwd"],
    ["data:text/plain,clerk"],
    ["javascript:alert(1)"],
    ["ftp://example.com/mcp"],
  ])("rejects non-http(s) URL: %s", async (badUrl) => {
    await expect(mcpInstall({ client: ["cursor"], url: badUrl })).rejects.toMatchObject({
      code: "mcp_url_required",
    });
  });

  test("rejects unparseable URL", async () => {
    await expect(mcpInstall({ client: ["cursor"], url: "not a url" })).rejects.toMatchObject({
      code: "mcp_url_required",
    });
  });

  test("prints next steps with a sign-in reminder after a human-mode install", async () => {
    await mcpInstall({ client: ["cursor"], url: URL_A });
    expect(captured.err).toContain("Next steps:");
    expect(captured.err).toContain("Reload Cursor");
    expect(captured.err).toContain("sign in");
  });

  test("omits next steps from JSON output", async () => {
    await mcpInstall({ client: ["cursor"], url: URL_A, json: true });
    expect(captured.err).not.toContain("Next steps:");
  });

  test("does not print next steps when the entry was unchanged", async () => {
    await mcpInstall({ client: ["cursor"], url: URL_A });
    captured.clear();
    await mcpInstall({ client: ["cursor"], url: URL_A });
    expect(captured.err).not.toContain("Next steps:");
  });

  test("rejects an unknown --client id", async () => {
    await expect(mcpInstall({ client: ["bogus"], url: URL_A })).rejects.toMatchObject({
      code: "mcp_client_not_supported",
    });
  });

  test("installs the healthy clients and warns when one config is corrupt", async () => {
    mockIsAgent.mockReturnValue(true);
    // Pre-corrupt Cursor's config; Claude Code's is absent (clean).
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");

    await mcpInstall({ client: ["cursor", "claude-code"], url: URL_A });

    const payload = JSON.parse(captured.out) as { results: { client: string; status: string }[] };
    expect(payload.results).toEqual([
      expect.objectContaining({ client: "claude-code", status: "added" }),
    ]);
    expect(captured.err).toContain("Cursor"); // per-client warning for the failure
  });

  test("throws when every targeted client fails", async () => {
    await mkdir(join(cwd, ".cursor"), { recursive: true });
    await writeFile(join(cwd, ".cursor", "mcp.json"), "{ not json");

    await expect(mcpInstall({ client: ["cursor"], url: URL_A })).rejects.toMatchObject({
      code: "mcp_client_config_invalid",
    });
  });
});
