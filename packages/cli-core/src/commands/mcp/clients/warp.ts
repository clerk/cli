/**
 * Writes Warp's user-global `~/.warp/.mcp.json` directly — the documented
 * file surface behind `Settings → Agents → MCP servers`. Warp ships no
 * registration CLI (its `oz` CLI only attaches servers to cloud-agent runs),
 * so the file write is the only non-interactive path. Standard
 * `mcpServers` + `{ command, args }` dialect.
 */

import { clerkRunDescriptor, clerkRunUrl } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const warpClient = makeJsonClient({
  id: "warp",
  displayName: "Warp",
  scope: "user",
  activation:
    "Restart Warp, then enable the server under `Settings → Agents → MCP servers` (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: clerkRunDescriptor,
  extractUrl: clerkRunUrl,
  configPath: () => userPath(".warp", ".mcp.json"),
  detect: () => pathExists(userPath(".warp")),
});
