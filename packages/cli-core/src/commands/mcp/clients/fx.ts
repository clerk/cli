/**
 * Writes fx's user-global `~/.fx/mcp.json` directly — the trusted profile fx
 * reads on every start (fx 0.0.7 also loads workspace `.mcp.json` servers,
 * but those sit behind per-workspace trust approval; the profile needs none
 * and follows the user everywhere). fx does ship `fx mcp add --transport
 * http` (verified in 0.0.7), but it is newer than fx's own docs, so the
 * direct write keeps registration working on fx binaries that predate it.
 * fx speaks Streamable HTTP natively, so unlike the bridge-backed clients
 * the entry points straight at the remote URL: entries live under top-level
 * `mcp` as `{ "type": "http", "url": … }`. The URL is therefore embedded at
 * install time rather than resolved by `clerk mcp run` at connect time.
 *
 * fx accepts `mcpServers` as a profile alias for `mcp` (and ignores the
 * alias whenever `mcp` exists), so writing a fresh `mcp` next to an
 * alias-form profile would shadow every server in it. `normalizeConfig`
 * folds an alias-only profile into canonical `mcp` before any read or
 * write — the same migration fx itself performs on its own writes.
 */

import { getMcpUrl } from "../../../lib/environment.ts";
import { isRecord } from "../../../lib/objects.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

function extractFxUrl(descriptor: unknown): string | undefined {
  if (!isRecord(descriptor)) return undefined;
  const url = (descriptor as { url?: unknown }).url;
  return typeof url === "string" ? url : undefined;
}

/**
 * A direct-URL fx entry has no `clerk mcp run` argv to recognize, so
 * provenance rides on the URL: an HTTP descriptor pointing at the currently
 * resolved Clerk MCP URL is ours. This is what keeps a `--name` install
 * against a `CLERK_MCP_URL` override (local worker dev) visible to
 * `list`/`doctor`/uninstall while that override is active — the generic
 * name/clerk-host checks in `list` already cover the default cases.
 */
function isOurFxEntry(descriptor: unknown): boolean {
  if (!isRecord(descriptor) || (descriptor as { type?: unknown }).type !== "http") return false;
  return extractFxUrl(descriptor) === getMcpUrl();
}

function normalizeFxConfig(config: Record<string, unknown>): Record<string, unknown> {
  const { mcpServers, ...rest } = config;
  // `mcp` present → fx ignores the alias entirely; leave the config alone
  // rather than merging servers fx itself refuses to load.
  if (isRecord(config.mcp) || !isRecord(mcpServers)) return config;
  return { ...rest, mcp: mcpServers };
}

export const fxClient = makeJsonClient({
  id: "fx",
  displayName: "fx",
  scope: "user",
  activation: "Run `/mcp reload` inside an fx session (or restart fx); `/mcp list` verifies.",
  topKey: "mcp",
  encode: (url) => ({ type: "http", url }),
  extractUrl: extractFxUrl,
  isOurs: isOurFxEntry,
  normalizeConfig: normalizeFxConfig,
  configPath: () => userPath(".fx", "mcp.json"),
  detect: async () => pathExists(userPath(".fx")),
});
