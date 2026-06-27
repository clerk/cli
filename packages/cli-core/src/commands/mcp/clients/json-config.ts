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

import { chmod, mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { log } from "../../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../../lib/errors.ts";

export interface ConfigRecord {
  [key: string]: unknown;
}

/** Read a config file's text, or `undefined` if absent. An unreadable file
 * (e.g. EACCES) surfaces as MCP_CLIENT_CONFIG_INVALID, not a raw OS error. */
export async function readConfigText(path: string): Promise<string | undefined> {
  const file = Bun.file(path);
  if (!(await file.exists())) return undefined;
  try {
    return await file.text();
  } catch (error) {
    throw new CliError(`Could not read ${path}: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
}

export async function readJsonConfig(path: string): Promise<ConfigRecord> {
  const text = await readConfigText(path);
  if (text === undefined || text.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new CliError(`Config at ${path} is not a JSON object`, {
        code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
      });
    }
    return parsed as ConfigRecord;
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(`Could not parse ${path} as JSON: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
}

export async function writeJsonConfig(path: string, config: ConfigRecord): Promise<void> {
  log.debug(`mcp: write ${path}`);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Atomic write: write to a sibling temp file then rename so a concurrent
  // reader (e.g. Claude Code) never sees a partial file.
  const tmp = `${path}.clerk-tmp-${process.pid}`;
  try {
    await writeFile(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await restrictPermissions(path);
}

/** Owner-only (0600) perms so editor-written OAuth tokens can't land in a
 * world-readable file on shared hosts. Best-effort: ignored without POSIX modes. */
export async function restrictPermissions(path: string): Promise<void> {
  try {
    await chmod(path, 0o600);
  } catch (error) {
    log.debug(`mcp: chmod ${path} failed — ${errorMessage(error)}`);
  }
}

/**
 * Get an object-typed nested value, returning a fresh empty object if missing.
 * Throws MCP_CLIENT_CONFIG_INVALID if the path exists but is not an object.
 */
export function getServerMap(
  config: ConfigRecord,
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
