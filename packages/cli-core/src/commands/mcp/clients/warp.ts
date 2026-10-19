/**
 * Writes Warp's user-global `~/.warp/.mcp.json` directly — the documented
 * file surface behind `Settings → Agents → MCP servers`. Warp ships no
 * registration CLI (its `oz` CLI only attaches servers to cloud-agent runs),
 * so the file write is the only non-interactive path. Standard `mcpServers`
 * dialect with a bare `{ url }`; Warp opens the OAuth sign-in itself.
 */

import { makeJsonClient, urlField } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const warpClient = makeJsonClient({
  id: "warp",
  displayName: "Warp",
  scope: "user",
  activation: () =>
    "Restart Warp, then enable the server under `Settings → Agents → MCP servers` and sign in to Clerk in the browser window it opens.",
  topKey: "mcpServers",
  encode: (url) => ({ url }),
  extractUrl: urlField("url"),
  configPath: () => userPath(".warp", ".mcp.json"),
  detect: async () => pathExists(userPath(".warp")),
});
