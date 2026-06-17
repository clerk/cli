/**
 * Writes to the user-global `~/.claude.json` under `mcpServers`, so the server
 * is available in every project (the same store `claude mcp add -s user` uses)
 * rather than gated behind a per-project `.mcp.json` approval. Installs the
 * `clerk mcp run` stdio bridge; legacy `{ type: "http", url }` entries still
 * round-trip on list/uninstall.
 */

import { clerkRunArgs, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const claudeClient = makeJsonClient({
  id: "claude",
  displayName: "Claude Code",
  scope: "user",
  activation: "Restart Claude Code, then run `/mcp` to connect (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: (url) => ({ command: RUN_COMMAND, args: clerkRunArgs(url) }),
  extractUrl: (d) => withLegacyUrl(d),
  configPath: () => userPath(".claude.json"),
  detect: () => pathExists(userPath(".claude")),
});
