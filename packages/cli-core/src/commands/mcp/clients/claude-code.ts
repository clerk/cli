/**
 * Claude Code MCP client integration.
 *
 * Writes to `.mcp.json` in the current working directory — the project-scope
 * config Claude Code reads automatically. Schema follows the MCP spec's HTTP
 * transport form: `{ type: "http", url: "<endpoint>" }`.
 */

import { hasStringProp, makeJsonClient } from "./make-json-client.ts";
import { pathExists, projectPath, userPath } from "./paths.ts";

export const claudeCodeClient = makeJsonClient({
  id: "claude-code",
  displayName: "Claude Code",
  scope: "project",
  activation: "Restart Claude Code, then run `/mcp` to connect (sign in if prompted).",
  topKey: "mcpServers",
  encode: (url) => ({ type: "http", url }),
  extractUrl: (d) => (hasStringProp(d, "url") ? d.url : undefined),
  configPath: (cwd) => projectPath(cwd, ".mcp.json"),
  detect: () => pathExists(userPath(".claude")),
});
