/**
 * Factory for JSON-backed MCP clients.
 *
 * Five of the supported clients share the same upsert/remove/list shape — a
 * JSON file with a top-level object whose keys are server names and whose
 * values are per-client server descriptors. The only differences are the
 * top-level key name (`mcpServers` vs `servers`) and the descriptor encoding
 * (`{ url }` vs `{ serverUrl }` vs `{ command, args }`). This factory captures
 * those differences as `topKey` + `encode` + `extractUrl` and reuses the rest.
 */

import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { getServerMap, readJsonConfig, writeJsonConfig, type JsonConfig } from "./json-config.ts";
import type {
  ClientId,
  ListEntry,
  McpClient,
  McpServerEntry,
  RemoveResult,
  Scope,
  UpsertResult,
} from "./types.ts";

export function hasStringProp<K extends string>(
  value: unknown,
  key: K,
): value is Record<K, string> {
  return (
    typeof value === "object" &&
    value !== null &&
    Object.prototype.hasOwnProperty.call(value, key) &&
    typeof (value as Record<string, unknown>)[key] === "string"
  );
}

interface JsonClientSpec {
  id: ClientId;
  displayName: string;
  scope: Scope;
  activation: string;
  topKey: string;
  /** Encode the per-client server descriptor for this URL. */
  encode: (url: string) => Record<string, unknown>;
  /** Extract a URL back out of a server descriptor (for `list`). Returns undefined when the shape doesn't match. */
  extractUrl: (descriptor: unknown) => string | undefined;
  configPath: (cwd: string) => string;
  detect: (cwd: string) => Promise<boolean>;
}

function isClerkUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.hostname === "mcp.clerk.com" || parsed.hostname.endsWith(".clerk.com");
  } catch {
    return false;
  }
}

export function makeJsonClient(spec: JsonClientSpec): McpClient {
  return {
    id: spec.id,
    displayName: spec.displayName,
    scope: spec.scope,
    activation: spec.activation,
    configPath: spec.configPath,
    detect: spec.detect,

    async upsert(entry: McpServerEntry, cwd: string, force: boolean): Promise<UpsertResult> {
      const configPath = spec.configPath(cwd);
      const config = await readJsonConfig(configPath);
      const servers = getServerMap(config, spec.topKey, configPath);

      // Own-property only: `servers[name]` / `name in servers` would walk the
      // prototype chain, so names like `toString` or `constructor` would read
      // back an inherited function and falsely look like an existing entry.
      const hasExisting = Object.prototype.hasOwnProperty.call(servers, entry.name);
      const existing = hasExisting ? servers[entry.name] : undefined;

      if (existing !== undefined) {
        const existingUrl = spec.extractUrl(existing);
        if (existingUrl === entry.url) {
          return { client: spec.id, configPath, status: "unchanged" };
        }
        if (!force) {
          return {
            client: spec.id,
            configPath,
            status: "skipped",
            reason: `entry "${entry.name}" already points at ${existingUrl ?? "another server"} — pass --force to overwrite`,
          };
        }
      }

      const desired = spec.encode(entry.url);
      const next: JsonConfig = { ...config, [spec.topKey]: { ...servers, [entry.name]: desired } };
      await writeJsonConfig(configPath, next);
      const status = hasExisting ? "updated" : "added";
      log.debug(`mcp: ${spec.id} ${status} "${entry.name}"`);
      return { client: spec.id, configPath, status };
    },

    async remove(name: string, cwd: string): Promise<RemoveResult> {
      const configPath = spec.configPath(cwd);
      const config = await readJsonConfig(configPath);
      const servers = getServerMap(config, spec.topKey, configPath);
      if (!Object.prototype.hasOwnProperty.call(servers, name)) {
        return { client: spec.id, configPath, removed: false };
      }
      const { [name]: _removed, ...rest } = servers;
      const next: JsonConfig = { ...config, [spec.topKey]: rest };
      await writeJsonConfig(configPath, next);
      log.debug(`mcp: ${spec.id} removed "${name}"`);
      return { client: spec.id, configPath, removed: true };
    },

    async list(cwd: string): Promise<ListEntry[]> {
      const configPath = spec.configPath(cwd);
      // A half-written or structurally-invalid config (unparseable JSON, or a
      // non-object `mcpServers`/`servers` value) shouldn't crash `mcp list`
      // across the other clients — treat it as "no entries". Both readJsonConfig
      // and getServerMap raise MCP_CLIENT_CONFIG_INVALID, so they share one guard.
      let servers: Record<string, unknown>;
      try {
        const config = await readJsonConfig(configPath);
        servers = getServerMap(config, spec.topKey, configPath);
      } catch (error) {
        if (error instanceof CliError && error.code === ERROR_CODE.MCP_CLIENT_CONFIG_INVALID) {
          // Warn rather than silently returning [] — the user must know their
          // config was skipped, not treated as empty.
          log.warn(`${spec.displayName}: ${error.message}`);
          return [];
        }
        throw error;
      }
      const entries: ListEntry[] = [];
      for (const [name, descriptor] of Object.entries(servers)) {
        const url = spec.extractUrl(descriptor);
        if (!url) continue;
        if (name === "clerk" || isClerkUrl(url)) {
          entries.push({ client: spec.id, configPath, name, url });
        }
      }
      return entries;
    },
  };
}
