/**
 * Registration is delegated to Claude Code's own CLI:
 * `claude mcp add --scope user … -- clerk mcp run`, so Claude Code owns its
 * config format and write safety. The file-backed base still reads the
 * user-global `~/.claude.json` (`mcpServers`) — the store `--scope user`
 * writes to — for `list`/`doctor`.
 */

import { clerkRunArgs, clerkRunDescriptor, clerkRunUrl, RUN_COMMAND } from "./clerk-run.ts";
import { makeCliClient } from "./make-cli-client.ts";
import { makeReadOnlyJsonClient } from "./make-client.ts";
import { userPath } from "./paths.ts";

const claudeFileClient = makeReadOnlyJsonClient({
  id: "claude",
  displayName: "Claude Code",
  scope: "user",
  activation: "Restart Claude Code, then run `/mcp` to connect (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: clerkRunDescriptor,
  extractUrl: clerkRunUrl,
  configPath: () => userPath(".claude.json"),
});

export const claudeClient = makeCliClient({
  base: claudeFileClient,
  binary: "claude",
  installHint: "Install Claude Code: https://claude.com/claude-code",
  addArgs: (name) => [
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "stdio",
    name,
    "--",
    RUN_COMMAND,
    ...clerkRunArgs(),
  ],
  removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
});
