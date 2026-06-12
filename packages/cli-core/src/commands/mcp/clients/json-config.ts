/**
 * Shared JSON read/write helper for MCP client configs.
 *
 * All five supported clients (Claude Code, Cursor, VS Code, Windsurf, Gemini)
 * store their MCP servers in a JSON file under a single top-level key
 * (`mcpServers` for most, `servers` for VS Code). The entry shape varies
 * (`url` vs `serverUrl` vs `command`+`args`) — that's per-client. This module
 * only handles the surrounding I/O: read, parse, write back with stable
 * formatting and a 2-space indent.
 */

import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";

export interface JsonConfig {
  [key: string]: unknown;
}

export async function readJsonConfig(path: string): Promise<JsonConfig> {
  const file = Bun.file(path);
  if (!(await file.exists())) return {};
  const text = await file.text();
  if (text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError(`Config at ${path} is not a JSON object`, {
        code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
      });
    }
    return parsed as JsonConfig;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Could not parse ${path} as JSON: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
}

export async function writeJsonConfig(path: string, config: JsonConfig): Promise<void> {
  log.debug(`mcp: write ${path}`);
  await mkdir(dirname(path), { recursive: true });
  await Bun.write(path, JSON.stringify(config, null, 2) + "\n");
}

/**
 * Get an object-typed nested value, returning a fresh empty object if missing.
 * Throws MCP_CLIENT_CONFIG_INVALID if the path exists but is not an object.
 */
export function getServerMap(
  config: JsonConfig,
  key: string,
  configPath: string,
): Record<string, unknown> {
  const existing = config[key];
  if (existing === undefined) return {};
  if (existing === null || typeof existing !== "object" || Array.isArray(existing)) {
    throw new CliError(`"${key}" in ${configPath} is not an object`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
  return existing as Record<string, unknown>;
}
