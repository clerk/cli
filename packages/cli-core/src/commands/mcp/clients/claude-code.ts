/**
 * Writes to the user-global `~/.claude.json` under `mcpServers`, so the server
 * is available in every project (the same store `claude mcp add -s user` uses)
 * rather than gated behind a per-project `.mcp.json` approval. Schema follows
 * the MCP spec's HTTP transport form: `{ type: "http", url: "<endpoint>" }`.
 */

import { hasStringProp, makeJsonClient } from "./make-json-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const claudeCodeClient = makeJsonClient({
  id: "claude-code",
  displayName: "Claude Code",
  scope: "user",
  activation: "Restart Claude Code, then run `/mcp` to connect (sign in if prompted).",
  topKey: "mcpServers",
  encode: (url) => ({ type: "http", url }),
  extractUrl: (d) => (hasStringProp(d, "url") ? d.url : undefined),
  configPath: () => userPath(".claude.json"),
  detect: () => pathExists(userPath(".claude")),
});
