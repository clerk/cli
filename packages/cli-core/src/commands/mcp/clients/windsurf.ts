/**
 * Writes to `~/.codeium/windsurf/mcp_config.json` (user scope). Installs the
 * `clerk mcp run` stdio bridge; legacy `{ serverUrl }` entries still round-trip
 * on list/uninstall.
 */

import { clerkRunArgs, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const windsurfClient = makeJsonClient({
  id: "windsurf",
  displayName: "Windsurf",
  scope: "user",
  activation:
    "Reload Windsurf, then turn on the server in `Cascade → MCP` (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: (url) => ({ command: RUN_COMMAND, args: clerkRunArgs(url) }),
  extractUrl: (d) => withLegacyUrl(d, "serverUrl"),
  configPath: () => userPath(".codeium", "windsurf", "mcp_config.json"),
  detect: () => pathExists(userPath(".codeium", "windsurf")),
});
