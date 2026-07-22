/**
 * Read-only TOML config access for MCP clients whose config is TOML (Codex).
 *
 * Codex stores its MCP servers in `~/.codex/config.toml` under the
 * `[mcp_servers.<name>]` table — same logical shape as the JSON clients, just
 * a different on-disk format. Reads power `list`/`doctor` and the
 * CLI-delegation presence checks. Writes are refused by design: Codex's own
 * CLI handles both add and remove, so no code path needs a TOML write — and
 * re-serializing would destroy the comments and formatting in a user's
 * hand-maintained `config.toml`.
 */

import { readParsedConfig, refuseConfigWrite, type ConfigRecord } from "./json-config.ts";

export async function readTomlConfig(path: string): Promise<ConfigRecord> {
  // A valid TOML document is always a table, so the shape guard can only fire
  // on a future parser swap — kept anyway for the shared contract.
  return readParsedConfig(path, {
    name: "TOML",
    shape: "TOML table",
    parse: (text) => Bun.TOML.parse(text),
  });
}

export async function writeTomlConfig(path: string, _config: ConfigRecord): Promise<void> {
  return refuseConfigWrite(path);
}
