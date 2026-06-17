/**
 * Writes to the user-global `mcp.json` under VS Code's per-OS user config dir
 * (the file behind `MCP: Open User Configuration`), so the server is available
 * across every workspace. VS Code uses the top-level key `servers` (not
 * `mcpServers`) and tags stdio servers with `type: "stdio"`. Installs the
 * `clerk mcp run` bridge; legacy `{ type: "http", url }` entries still
 * round-trip on list/uninstall.
 */

import { join } from "node:path";
import { clerkRunArgs, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, vscodeUserDir } from "./paths.ts";

export const vscodeClient = makeJsonClient({
  id: "vscode",
  displayName: "GitHub Copilot",
  scope: "user",
  activation:
    "Reload the VS Code window, then start the server from `MCP: List Servers` (`clerk` must be on your PATH).",
  topKey: "servers",
  encode: (url) => ({ type: "stdio", command: RUN_COMMAND, args: clerkRunArgs(url) }),
  extractUrl: (d) => withLegacyUrl(d),
  configPath: () => join(vscodeUserDir(), "mcp.json"),
  detect: () => pathExists(vscodeUserDir()),
});
