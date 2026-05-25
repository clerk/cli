/**
 * Windsurf MCP client integration.
 *
 * Writes to `~/.codeium/windsurf/mcp_config.json` (user scope). Server
 * descriptor uses `serverUrl`, not `url`.
 */

import { hasStringProp, makeJsonClient } from "./make-json-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const windsurfClient = makeJsonClient({
  id: "windsurf",
  displayName: "Windsurf",
  scope: "user",
  activation: "Reload Windsurf, then turn on the server in `Cascade → MCP` (sign in if prompted).",
  topKey: "mcpServers",
  encode: (url) => ({ serverUrl: url }),
  extractUrl: (d) => (hasStringProp(d, "serverUrl") ? d.serverUrl : undefined),
  configPath: () => userPath(".codeium", "windsurf", "mcp_config.json"),
  detect: () => pathExists(userPath(".codeium", "windsurf")),
});
