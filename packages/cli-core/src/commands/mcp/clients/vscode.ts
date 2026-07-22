/**
 * Registration is delegated to VS Code's own CLI: `code --add-mcp '<json>'`,
 * which writes the user-profile `mcp.json`. VS Code has an add command but no
 * removal counterpart, so `remove` (and the pre-clean before re-install) falls
 * back to the file-backed base editing the user-global `mcp.json` under VS
 * Code's per-OS user config dir (the file behind `MCP: Open User
 * Configuration`). VS Code uses the top-level key `servers` (not `mcpServers`)
 * and tags stdio servers with `type: "stdio"`.
 */

import { join } from "node:path";
import { clerkRunArgs, clerkRunUrl, RUN_COMMAND } from "./clerk-run.ts";
import { makeCliClient } from "./make-cli-client.ts";
import { makeJsonClient } from "./make-client.ts";
import { vscodeUserDir } from "./paths.ts";

const vscodeFileClient = makeJsonClient({
  id: "vscode",
  displayName: "GitHub Copilot",
  scope: "user",
  activation:
    "Reload the VS Code window, then start the server from `MCP: List Servers` (`clerk` must be on your PATH).",
  topKey: "servers",
  encode: () => ({ type: "stdio", command: RUN_COMMAND, args: clerkRunArgs() }),
  extractUrl: clerkRunUrl,
  configPath: () => join(vscodeUserDir(), "mcp.json"),
});

export const vscodeClient = makeCliClient({
  base: vscodeFileClient,
  binary: "code",
  installHint:
    "Install the `code` shell command from VS Code (\"Shell Command: Install 'code' command in PATH\").",
  addArgs: (name) => [
    "--add-mcp",
    JSON.stringify({ name, type: "stdio", command: RUN_COMMAND, args: clerkRunArgs() }),
  ],
});
