/**
 * Cursor MCP client integration.
 *
 * Writes to `.cursor/mcp.json` in the current working directory. Cursor's
 * MCP descriptor is a bare `{ url }` without a `type` discriminator.
 */

import { hasStringProp, makeJsonClient } from "./make-json-client.ts";
import { pathExists, projectPath, userPath } from "./paths.ts";

export const cursorClient = makeJsonClient({
  id: "cursor",
  displayName: "Cursor",
  scope: "project",
  activation: "Reload Cursor, then enable the server under `Settings → MCP` (sign in if prompted).",
  topKey: "mcpServers",
  encode: (url) => ({ url }),
  extractUrl: (d) => (hasStringProp(d, "url") ? d.url : undefined),
  configPath: (cwd) => projectPath(cwd, ".cursor", "mcp.json"),
  detect: () => pathExists(userPath(".cursor")),
});
