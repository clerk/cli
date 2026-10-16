/**
 * Writes to the user-global `~/.cursor/mcp.json`, so the server is available in
 * every project rather than only the cwd it was installed from. Cursor speaks
 * Streamable HTTP natively and runs the OAuth sign-in itself: the entry is a
 * bare `{ url }`.
 */

import { makeJsonClient, urlField } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const cursorClient = makeJsonClient({
  id: "cursor",
  displayName: "Cursor",
  scope: "user",
  activation: () =>
    "Reload Cursor, then enable the server under `Settings → MCP` and sign in to Clerk when prompted.",
  topKey: "mcpServers",
  encode: (url) => ({ url }),
  extractUrl: urlField("url"),
  configPath: () => userPath(".cursor", "mcp.json"),
  detect: async () => pathExists(userPath(".cursor")),
});
