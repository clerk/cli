/**
 * Writes to the user-global `mcp.json` under VS Code's per-OS user config dir
 * (the file behind `MCP: Open User Configuration`), so the server is available
 * across every workspace. VS Code uses the top-level key `servers` (not
 * `mcpServers`) and the HTTP transport form `{ type: "http", url }`.
 */

import { join } from "node:path";
import { hasStringProp, makeJsonClient } from "./make-json-client.ts";
import { pathExists, vscodeUserDir } from "./paths.ts";

export const vscodeClient = makeJsonClient({
  id: "vscode",
  displayName: "GitHub Copilot",
  scope: "user",
  activation:
    "Reload the VS Code window, then start the server from `MCP: List Servers` (sign in if prompted).",
  topKey: "servers",
  encode: (url) => ({ type: "http", url }),
  extractUrl: (d) => (hasStringProp(d, "url") ? d.url : undefined),
  configPath: () => join(vscodeUserDir(), "mcp.json"),
  detect: () => pathExists(vscodeUserDir()),
});
