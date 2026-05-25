/**
 * VS Code (Copilot) MCP client integration.
 *
 * Writes to `.vscode/mcp.json` in the current working directory. VS Code uses
 * the top-level key `servers` (not `mcpServers`) and the HTTP transport form
 * `{ type: "http", url }`.
 */

import { hasStringProp, makeJsonClient } from "./make-json-client.ts";
import { pathExists, projectPath, userPath } from "./paths.ts";

export const vscodeClient = makeJsonClient({
  id: "vscode",
  displayName: "VS Code",
  scope: "project",
  activation:
    "Reload the VS Code window, then start the server from `MCP: List Servers` (sign in if prompted).",
  topKey: "servers",
  encode: (url) => ({ type: "http", url }),
  extractUrl: (d) => (hasStringProp(d, "url") ? d.url : undefined),
  configPath: (cwd) => projectPath(cwd, ".vscode", "mcp.json"),
  detect: () => pathExists(userPath(".vscode")),
});
