/**
 * Writes to `~/.codeium/windsurf/mcp_config.json` (user scope). Windsurf
 * speaks Streamable HTTP natively; its documented remote-server key is
 * `serverUrl`.
 */

import { makeJsonClient, urlField } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const windsurfClient = makeJsonClient({
  id: "windsurf",
  displayName: "Windsurf",
  scope: "user",
  activation: () =>
    "Reload Windsurf, then turn on the server in `Cascade → MCP` and sign in to Clerk when prompted.",
  topKey: "mcpServers",
  encode: (url) => ({ serverUrl: url }),
  extractUrl: urlField("serverUrl"),
  configPath: () => userPath(".codeium", "windsurf", "mcp_config.json"),
  detect: async () => pathExists(userPath(".codeium", "windsurf")),
});
