/**
 * Writes to the user-global `~/.cursor/mcp.json`, so the server is available in
 * every project rather than only the cwd it was installed from. Installs the
 * `clerk mcp run` stdio bridge; legacy bare `{ url }` entries still round-trip
 * on list/uninstall.
 */

import { clerkRunArgs, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const cursorClient = makeJsonClient({
  id: "cursor",
  displayName: "Cursor",
  scope: "user",
  activation:
    "Reload Cursor, then enable the server under `Settings → MCP` (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: () => ({ command: RUN_COMMAND, args: clerkRunArgs() }),
  extractUrl: (d) => withLegacyUrl(d),
  configPath: () => userPath(".cursor", "mcp.json"),
  detect: () => pathExists(userPath(".cursor")),
});
