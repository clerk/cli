/**
 * Read-only YAML config access for MCP clients whose config is YAML (Hermes).
 *
 * Reads power `list`/`doctor` and the CLI-delegation presence checks. Writes
 * are refused by design: Hermes' own CLI handles both add and remove, so no
 * code path needs a YAML write — and `Bun.YAML.stringify` would destroy the
 * comments and formatting in a user's hand-maintained `config.yaml`.
 */

import { isRecord } from "../../../lib/objects.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import { readConfigText, refuseConfigWrite, type ConfigRecord } from "./json-config.ts";

export async function readYamlConfig(path: string): Promise<ConfigRecord> {
  const text = await readConfigText(path);
  if (text === undefined || text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(text);
  } catch (error) {
    throw new CliError(`Could not parse ${path} as YAML: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
  if (!isRecord(parsed)) {
    throw new CliError(`Config at ${path} is not a YAML mapping`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
  return parsed as ConfigRecord;
}

export async function writeYamlConfig(path: string, _config: ConfigRecord): Promise<void> {
  return refuseConfigWrite(path);
}
