import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readYamlConfig, writeYamlConfig } from "./yaml-config.ts";

describe("yaml-config", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "clerk-mcp-yaml-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("returns an empty record when the file is absent", async () => {
    expect(await readYamlConfig(join(dir, "missing.yaml"))).toEqual({});
  });

  test("parses a Hermes-style mcp_servers map", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(
      path,
      "mcp_servers:\n  clerk:\n    command: clerk\n    args: [mcp, run]\n    enabled: true\n",
    );
    expect(await readYamlConfig(path)).toEqual({
      mcp_servers: { clerk: { command: "clerk", args: ["mcp", "run"], enabled: true } },
    });
  });

  test("rejects malformed YAML with MCP_CLIENT_CONFIG_INVALID", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "mcp_servers:\n  clerk: [unclosed\n");
    await expect(readYamlConfig(path)).rejects.toMatchObject({
      code: "mcp_client_config_invalid",
    });
  });

  test("rejects a non-object top level with MCP_CLIENT_CONFIG_INVALID", async () => {
    const path = join(dir, "config.yaml");
    await writeFile(path, "- just\n- a\n- list\n");
    await expect(readYamlConfig(path)).rejects.toMatchObject({
      code: "mcp_client_config_invalid",
    });
  });

  test("writes are refused — Hermes config edits are delegated to its CLI", async () => {
    // Reads are ours (list/doctor); rewriting the user's YAML would destroy
    // comments and formatting, and no code path needs it (the Hermes CLI owns
    // both add and remove). Unreachable in practice; explicit if ever reached.
    await expect(writeYamlConfig(join(dir, "config.yaml"), {})).rejects.toThrow(/delegated/);
  });
});
