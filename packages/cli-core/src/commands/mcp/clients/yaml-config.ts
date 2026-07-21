/**
 * Read-only YAML config access for MCP clients whose config is YAML (Hermes).
 *
 * Reads power `list`/`doctor` and the CLI-delegation presence checks. Writes
 * are refused by design: Hermes' own CLI handles both add and remove, so no
 * code path needs a YAML write — and `Bun.YAML.stringify` would destroy the
 * comments and formatting in a user's hand-maintained `config.yaml`.
 */

import { readParsedConfig, refuseConfigWrite, type ConfigRecord } from "./json-config.ts";

export async function readYamlConfig(path: string): Promise<ConfigRecord> {
  return readParsedConfig(path, {
    name: "YAML",
    shape: "YAML mapping",
    parse: (text) => Bun.YAML.parse(text),
  });
}

export async function writeYamlConfig(path: string, _config: ConfigRecord): Promise<void> {
  return refuseConfigWrite(path);
}
