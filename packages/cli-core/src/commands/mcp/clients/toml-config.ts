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

import { isRecord } from "../../../lib/objects.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import { readConfigText, refuseConfigWrite, type ConfigRecord } from "./json-config.ts";

export async function readTomlConfig(path: string): Promise<ConfigRecord> {
  const text = await readConfigText(path);
  if (text === undefined || text.trim().length === 0) return {};
  try {
    const parsed: unknown = Bun.TOML.parse(text);
    // A valid TOML document is always a table, so `parse` can't hand back a
    // non-object — but guard anyway so a future parser swap can't surprise us.
    if (!isRecord(parsed)) {
      throw new CliError(`Config at ${path} is not a TOML table`, {
        code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
      });
    }
    return parsed as ConfigRecord;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Could not parse ${path} as TOML: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
}

export async function writeTomlConfig(path: string, _config: ConfigRecord): Promise<void> {
  return refuseConfigWrite(path);
}
