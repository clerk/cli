/**
 * Writes fx's user-global `~/.fx/mcp.json` directly — the trusted profile fx
 * reads on every start (fx 0.0.7 also loads workspace `.mcp.json` servers,
 * but those sit behind per-workspace trust approval; the profile needs none
 * and follows the user everywhere). fx does ship `fx mcp add --transport
 * http` (verified in 0.0.7), but it is newer than fx's own docs, so the
 * direct write keeps registration working on fx binaries that predate it.
 * Entries live under top-level `mcp` as `{ "type": "http", "url": … }`; fx
 * runs the OAuth sign-in itself (`fx mcp auth <name>`).
 *
 * fx accepts `mcpServers` as a profile alias for `mcp` (and ignores the
 * alias whenever `mcp` exists), so writing a fresh `mcp` next to an
 * alias-form profile would shadow every server in it. `normalizeConfig`
 * folds an alias-only profile into canonical `mcp` before any read or
 * write — the same migration fx itself performs on its own writes.
 */

import { makeJsonClient, urlField } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

function normalizeFxConfig(config: Record<string, unknown>): Record<string, unknown> {
  // Presence decides, not shape — matching fx's own `mcp` orelse `mcpServers`
  // precedence. A present canonical key of any shape stays put so the
  // factory's validation sees it, and a present-but-malformed alias migrates
  // so validation rejects it instead of installing alongside a profile fx
  // itself refuses to load. (`mcp` present → fx ignores the alias entirely;
  // leave it alone rather than merging servers fx won't read.)
  if ("mcp" in config || !("mcpServers" in config)) return config;
  const { mcpServers, ...rest } = config;
  return { ...rest, mcp: mcpServers };
}

export const fxClient = makeJsonClient({
  id: "fx",
  displayName: "fx",
  scope: "user",
  activation: (name) =>
    `Run \`fx mcp auth ${name}\` to sign in to Clerk, then \`/mcp reload\` inside an fx session (or restart fx).`,
  topKey: "mcp",
  encode: (url) => ({ type: "http", url }),
  extractUrl: urlField("url"),
  normalizeConfig: normalizeFxConfig,
  configPath: () => userPath(".fx", "mcp.json"),
  detect: async () => pathExists(userPath(".fx")),
});
