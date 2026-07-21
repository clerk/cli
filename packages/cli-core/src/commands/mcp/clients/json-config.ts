/**
 * Shared JSON read/write helper for MCP client configs.
 *
 * Every JSON-backed client (Claude Code, Cursor, VS Code, Windsurf, Gemini,
 * opencode, OpenClaw, Warp) stores its MCP servers in a JSON file under a
 * top-level key
 * (`mcpServers` for most, `servers` for VS Code). The entry shape varies
 * (`url` vs `serverUrl` vs `command`+`args`) — that's per-client. This module
 * only handles the surrounding I/O: read, parse, write back with stable
 * formatting and a 2-space indent.
 *
 * Known limitation: reads use strict `JSON.parse`, so a hand-edited config
 * with comments (JSONC) fails to read, and writes re-serialize the whole
 * document, so any custom formatting is normalized away. Accepted because the
 * client owns its file: the clients we write for document plain JSON, and the
 * JSONC-tolerant ones (VS Code) delegate writes to their own CLI wherever
 * possible.
 */

import { isRecord } from "../../../lib/objects.ts";
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

/**
 * The read half shared by every codec: read the file, parse it with the
 * format's parser, and guard that the top level is a map. An absent or empty
 * file reads as `{}`; parse and shape failures surface as
 * MCP_CLIENT_CONFIG_INVALID.
 */
export async function readParsedConfig(
  path: string,
  format: { name: string; shape: string; parse: (text: string) => unknown },
): Promise<ConfigRecord> {
  const text = await readConfigText(path);
  if (text === undefined || text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = format.parse(text);
  } catch (error) {
    throw new CliError(`Could not parse ${path} as ${format.name}: ${errorMessage(error)}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
  if (!isRecord(parsed)) {
    throw new CliError(`Config at ${path} is not a ${format.shape}`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
  return parsed as ConfigRecord;
}

export async function readJsonConfig(path: string): Promise<ConfigRecord> {
  return readParsedConfig(path, {
    name: "JSON",
    shape: "JSON object",
    parse: (text) => JSON.parse(text) as unknown,
  });
}

export async function writeJsonConfig(path: string, config: ConfigRecord): Promise<void> {
  log.debug(`mcp: write ${path}`);
  const dir = dirname(path);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  // Atomic write: write to a sibling temp file then rename so a concurrent
  // reader (e.g. Claude Code) never sees a partial file. This prevents a torn
  // read but not a lost update — if the client itself rewrites this file
  // between our read and this rename (e.g. Claude Code persists its own state
  // to ~/.claude.json frequently), our rename clobbers that write. Same
  // tradeoff `claude mcp add` itself makes; install/uninstall is safest with
  // the target client closed.
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

/**
 * The write half of every read-only codec: CLI-delegated clients own both of
 * their config mutations, so a write reaching us is a wiring bug, not a user
 * error — refuse loudly instead of silently rewriting a file the client owns.
 */
export async function refuseConfigWrite(path: string): Promise<void> {
  throw new CliError(
    `Refusing to rewrite ${path} — config edits are delegated to the client's own CLI.`,
    { code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID },
  );
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
  if (!isRecord(existing)) {
    throw new CliError(`"${key}" in ${configPath} is not an object`, {
      code: ERROR_CODE.MCP_CLIENT_CONFIG_INVALID,
    });
  }
  return existing as Record<string, unknown>;
}
