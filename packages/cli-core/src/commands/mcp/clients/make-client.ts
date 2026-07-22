/**
 * Factory for file-backed MCP clients.
 *
 * Every supported client shares the same upsert/remove/list shape — a config
 * file with a top-level map whose keys are server names and whose values are
 * per-client server descriptors. The differences are the serialization format
 * (JSON for most clients, TOML for Codex, YAML for Hermes), the top-level key name (`mcpServers`
 * vs `servers` vs `mcp_servers`) and the descriptor encoding (the standard
 * `{ command, args }` vs VS Code's `type: "stdio"`-tagged variant vs
 * opencode's single argv array). This factory captures those as a
 * codec + `topKey` + `encode` + `extractUrl` and reuses the rest.
 */

import { log } from "../../../lib/log.ts";
import { isRecord } from "../../../lib/objects.ts";
import { isClerkRunEntry } from "./clerk-run.ts";
import {
  getServerMap,
  readJsonConfig,
  refuseConfigWrite,
  writeJsonConfig,
  type ConfigRecord,
} from "./json-config.ts";
import { readTomlConfig, writeTomlConfig } from "./toml-config.ts";
import { readYamlConfig, writeYamlConfig } from "./yaml-config.ts";
import type {
  ClientId,
  ListEntry,
  McpClient,
  McpServerEntry,
  RemoveResult,
  Scope,
  UpsertResult,
} from "./types.ts";

interface FileClientSpec {
  id: ClientId;
  displayName: string;
  scope: Scope;
  activation: string;
  /** Key (or non-empty key path, for clients that nest their server map) under which entries live. */
  topKey: string | readonly [string, ...string[]];
  /** Encode the per-client server descriptor for this URL. */
  encode: (url: string) => Record<string, unknown>;
  /** Extract a URL back out of a server descriptor (for `list`). Returns undefined when the shape doesn't match. */
  extractUrl: (descriptor: unknown) => string | undefined;
  /**
   * Recognize a `clerk mcp run` bridge descriptor in this client's dialect.
   * Only needed by clients whose encoding diverges from the standard
   * `{ command, args }` shape (opencode's single argv array); the default is
   * {@link isClerkRunEntry}.
   */
  isOurs?: (descriptor: unknown) => boolean;
  configPath: (cwd: string) => string;
  /**
   * Omit for bases wrapped by `makeCliClient`, which replaces detection with
   * its binary-on-PATH check — a config-dir probe would never run. A bare file
   * client without `detect` is never offered by the picker.
   */
  detect?: (cwd: string) => Promise<boolean>;
}

/** Read/write codec abstracting the on-disk format (JSON vs TOML). */
interface ConfigCodec {
  read: (path: string) => Promise<ConfigRecord>;
  write: (path: string, config: ConfigRecord) => Promise<void>;
}

const JSON_CODEC: ConfigCodec = { read: readJsonConfig, write: writeJsonConfig };
const READONLY_JSON_CODEC: ConfigCodec = { read: readJsonConfig, write: refuseConfigWrite };
const TOML_CODEC: ConfigCodec = { read: readTomlConfig, write: writeTomlConfig };
const YAML_CODEC: ConfigCodec = { read: readYamlConfig, write: writeYamlConfig };

/**
 * Rebuild `config` with the server map replaced at `path`, preserving sibling
 * keys at every level. An empty map is pruned, along with any ancestor object
 * the pruning left empty — so removing the last entry never strands
 * `{ "mcp": { "servers": {} } }` husks.
 */
function withServerMap(
  config: ConfigRecord,
  path: readonly [string, ...string[]],
  servers: Record<string, unknown>,
): ConfigRecord {
  const [head, ...rest] = path;
  let value: Record<string, unknown>;
  if (rest.length === 0) {
    value = servers;
  } else {
    const child = config[head];
    // `rest` is non-empty here (length checked above); TS can't carry
    // tuple-ness through a rest spread, so re-assert what the guard proved.
    value = withServerMap(isRecord(child) ? child : {}, rest as [string, ...string[]], servers);
  }
  if (Object.keys(value).length === 0) {
    const { [head]: _dropped, ...remaining } = config;
    return remaining;
  }
  return { ...config, [head]: value };
}

/** Single source of truth for "is this host under clerk.com". */
function isClerkHost(hostname: string): boolean {
  return hostname === "mcp.clerk.com" || hostname.endsWith(".clerk.com");
}

function isClerkUrl(url: string): boolean {
  try {
    return isClerkHost(new URL(url).hostname);
  } catch {
    return false;
  }
}

function makeFileClient(spec: FileClientSpec, codec: ConfigCodec): McpClient {
  const topKeyPath: readonly [string, ...string[]] =
    typeof spec.topKey === "string" ? [spec.topKey] : spec.topKey;

  const isOurs = spec.isOurs ?? isClerkRunEntry;

  /** Walk the key path, validating each level is an object (or absent → `{}`). */
  function serversIn(config: ConfigRecord, configPath: string): Record<string, unknown> {
    let node: Record<string, unknown> = config;
    for (const key of topKeyPath) {
      node = getServerMap(node, key, configPath);
    }
    return node;
  }

  return {
    id: spec.id,
    displayName: spec.displayName,
    scope: spec.scope,
    activation: spec.activation,
    configPath: spec.configPath,
    detect: spec.detect ?? (() => Promise.resolve(false)),

    async upsert(entry: McpServerEntry, cwd: string): Promise<UpsertResult> {
      const configPath = spec.configPath(cwd);
      const config = await codec.read(configPath);
      const servers = serversIn(config, configPath);

      // Install always converges: whatever descriptor sits under this name
      // (a legacy shape, a stale URL, a user's own entry) is overwritten with
      // the current bridge shape — the same semantics the CLI-backed clients
      // get from their remove-then-add.
      const next = withServerMap(config, topKeyPath, {
        ...servers,
        [entry.name]: spec.encode(entry.url),
      });
      await codec.write(configPath, next);
      log.debug(`mcp: ${spec.id} installed "${entry.name}"`);
      return { client: spec.id, configPath, status: "installed" };
    },

    async remove(name: string, cwd: string): Promise<RemoveResult> {
      const configPath = spec.configPath(cwd);
      const config = await codec.read(configPath);
      const servers = serversIn(config, configPath);
      if (!Object.prototype.hasOwnProperty.call(servers, name)) {
        return { client: spec.id, configPath, removed: false };
      }
      const { [name]: _removed, ...rest } = servers;
      // An emptied map is pruned (no `{ "mcpServers": {} }` husk) — nested
      // ancestors emptied by the pruning go with it.
      const next = withServerMap(config, topKeyPath, rest);
      await codec.write(configPath, next);
      log.debug(`mcp: ${spec.id} removed "${name}"`);
      return { client: spec.id, configPath, removed: true };
    },

    async list(cwd: string): Promise<ListEntry[]> {
      const configPath = spec.configPath(cwd);
      // A half-written or structurally-invalid config propagates as
      // MCP_CLIENT_CONFIG_INVALID. Aggregating callers (`collectEntries`,
      // uninstall's picker) settle per client, so one bad config warns there
      // without sinking the other clients — and `doctor` can tell "unreadable
      // config" apart from "no entries" instead of reporting a clean pass.
      const config = await codec.read(configPath);
      const servers = serversIn(config, configPath);
      const entries: ListEntry[] = [];
      for (const [name, descriptor] of Object.entries(servers)) {
        const url = spec.extractUrl(descriptor);
        if (!url) continue;
        // Descriptor shape first: a `clerk mcp run` bridge is ours no matter
        // what the entry is named or what URL it currently resolves to (e.g.
        // `--name foo` with `CLERK_MCP_URL` pointing at localhost) — otherwise
        // such an entry would fall out of list/doctor and couldn't be removed.
        if (isOurs(descriptor) || name === "clerk" || isClerkUrl(url)) {
          entries.push({ client: spec.id, configPath, name, url });
        }
      }
      return entries;
    },
  };
}

/**
 * A client whose JSON config we both read and write (Cursor, Windsurf, Warp,
 * opencode — no usable registration CLI — plus VS Code, whose add-only CLI
 * leaves removal to a file edit).
 */
export function makeJsonClient(spec: FileClientSpec): McpClient {
  return makeFileClient(spec, JSON_CODEC);
}

/**
 * A client whose JSON config is read-only to us (Claude Code, Gemini,
 * OpenClaw): its own CLI performs every mutation, so this base only powers
 * `list`/`doctor`/presence reads — a write reaching it throws.
 */
export function makeReadOnlyJsonClient(spec: FileClientSpec): McpClient {
  return makeFileClient(spec, READONLY_JSON_CODEC);
}

/** A client whose config is a TOML file (Codex). */
export function makeTomlClient(spec: FileClientSpec): McpClient {
  return makeFileClient(spec, TOML_CODEC);
}

/**
 * A client whose config is a YAML file (Hermes). Read-only: writes throw, so
 * only use as the base of a CLI-delegated client whose CLI owns add *and*
 * remove.
 */
export function makeYamlClient(spec: FileClientSpec): McpClient {
  return makeFileClient(spec, YAML_CODEC);
}
