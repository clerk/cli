/**
 * Writes to the user-global `~/.cursor/mcp.json`, so the server is available in
 * every project rather than only the cwd it was installed from. Cursor's MCP
 * descriptor is a bare `{ url }` without a `type` discriminator.
 */

import { hasStringProp, makeJsonClient } from "./make-json-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const cursorClient = makeJsonClient({
  id: "cursor",
  displayName: "Cursor",
  scope: "user",
  activation: "Reload Cursor, then enable the server under `Settings → MCP` (sign in if prompted).",
  topKey: "mcpServers",
  encode: (url) => ({ url }),
  extractUrl: (d) => (hasStringProp(d, "url") ? d.url : undefined),
  configPath: () => userPath(".cursor", "mcp.json"),
  detect: () => pathExists(userPath(".cursor")),
});
