/**
 * Registration is delegated to Claude Code's own CLI:
 * `claude mcp add --scope user --transport http <name> <url>`, so Claude Code
 * owns its config format and write safety. The file-backed base still reads
 * the user-global `~/.claude.json` (`mcpServers.<name> = { type: "http", url }`)
 * — the store `--scope user` writes to — for `list`/`doctor`.
 */

import { makeCliClient } from "./make-cli-client.ts";
import { makeReadOnlyJsonClient, urlField } from "./make-client.ts";
import { userPath } from "./paths.ts";

const claudeFileClient = makeReadOnlyJsonClient({
  id: "claude",
  displayName: "Claude Code",
  scope: "user",
  activation: () => "Restart Claude Code, then run `/mcp` to sign in to Clerk.",
  topKey: "mcpServers",
  encode: (url) => ({ type: "http", url }),
  extractUrl: urlField("url"),
  configPath: () => userPath(".claude.json"),
});

export const claudeClient = makeCliClient({
  base: claudeFileClient,
  binary: "claude",
  installHint: "Install Claude Code: https://claude.com/claude-code",
  addArgs: ({ name, url }) => ["mcp", "add", "--scope", "user", "--transport", "http", name, url],
  removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
});
