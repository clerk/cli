/**
 * TOML config access for MCP clients whose config is TOML (Codex).
 *
 * Codex stores its MCP servers in `~/.codex/config.toml` under the
 * `[mcp_servers.<name>]` table — same logical shape as the JSON clients, just
 * a different on-disk format. Reads power `list`/`doctor` and the
 * CLI-delegation presence checks.
 *
 * Whole-document writes are refused by design: re-serializing would destroy
 * the comments and formatting in a user's hand-maintained `config.toml`. The
 * one write we do make is {@link appendTomlTable}, a text append that leaves
 * every existing byte in place — `codex mcp add --url` can't be used for the
 * add because it starts a blocking browser OAuth login right after saving.
 */

import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import {
  readConfigText,
  readParsedConfig,
  refuseConfigWrite,
  restrictPermissions,
  type ConfigRecord,
} from "./json-config.ts";

// Bare TOML keys: ASCII letters, digits, `_` and `-`. `resolveName`'s
// allowlist is a subset, so entry names never need quoting.
const BARE_KEY = /^[A-Za-z0-9_-]+$/;

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

/**
 * Append a `[a.b.c]` table of string values to the end of a TOML file,
 * creating the file if needed. Existing content is preserved byte-for-byte.
 * The combined document is parsed before anything is written, so a table that
 * already exists (TOML forbids redefining one) or a corrupt file fails as
 * MCP_CLIENT_CONFIG_INVALID without touching the file.
 */
export async function appendTomlTable(
  path: string,
  table: readonly string[],
  values: Readonly<Record<string, string>>,
): Promise<void> {
  const keys = [...table, ...Object.keys(values)];
  const invalid = keys.find((key) => !BARE_KEY.test(key));
  if (invalid !== undefined) {
    throw new CliError(`Refusing to write TOML key "${invalid}" to ${path}.`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
  const existing = (await readConfigText(path)) ?? "";
  // JSON string escapes are a subset of TOML basic-string escapes, so a
  // JSON-encoded string is a valid TOML string.
  const block = [
    `[${table.join(".")}]`,
    ...Object.entries(values).map(([key, value]) => `${key} = ${JSON.stringify(value)}`),
  ].join("\n");
  const separator = existing.length === 0 ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
  const next = `${existing}${separator}${block}\n`;
  try {
    Bun.TOML.parse(next);
  } catch (error) {
    throw new CliError(`Could not add [${table.join(".")}] to ${path}: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }

  log.debug(`mcp: append [${table.join(".")}] to ${path}`);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  // Atomic write (temp file + rename) so Codex never reads a partial file.
  const tmp = `${path}.clerk-tmp-${process.pid}`;
  try {
    await writeFile(tmp, next, { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await restrictPermissions(path);
}
