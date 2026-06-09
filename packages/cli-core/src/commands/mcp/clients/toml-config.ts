/**
 * Shared TOML read/write helper for MCP client configs.
 *
 * Codex stores its MCP servers in `~/.codex/config.toml` under the
 * `[mcp_servers.<name>]` table — same logical shape as the JSON clients (a
 * top-level map of server name → descriptor), just a different on-disk format.
 * This module is the TOML counterpart to `json-config.ts`: it only handles the
 * surrounding I/O, parsing into and serializing from the plain object tree that
 * the client factory and `getServerMap` already operate on.
 *
 * Note: serializing drops comments and original formatting, matching how the
 * JSON clients rewrite their (sometimes JSONC) configs.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { parse, stringify } from "smol-toml";
import { log } from "../../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";
import type { JsonConfig } from "./json-config.ts";

export async function readTomlConfig(path: string): Promise<JsonConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const text = await file.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = parse(text);
    // A valid TOML document is always a table, so `parse` can't hand back a
    // non-object — but guard anyway so a future parser swap can't surprise us.
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError(`Config at ${path} is not a TOML table`, {
        code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
      });
    }
    return parsed as JsonConfig;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Could not parse ${path} as TOML: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
}

export async function writeTomlConfig(path: string, config: JsonConfig): Promise<void> {
  log.debug(`mcp: write ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, stringify(config) + "\n");
}
