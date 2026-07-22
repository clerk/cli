/**
 * Registration is delegated to Gemini's own CLI:
 * `gemini mcp add --scope user --transport stdio … clerk mcp run`. The
 * file-backed base still reads `~/.gemini/settings.json` for `list`/`doctor`.
 * Gemini has no native HTTP transport, so it always needs the stdio bridge.
 */

import { clerkRunArgs, clerkRunDescriptor, clerkRunUrl, RUN_COMMAND } from "./clerk-run.ts";
import { makeCliClient } from "./make-cli-client.ts";
import { makeReadOnlyJsonClient } from "./make-client.ts";
import { userPath } from "./paths.ts";

const geminiFileClient = makeReadOnlyJsonClient({
  id: "gemini",
  displayName: "Gemini Code Assist / CLI",
  scope: "user",
  activation: "Restart Gemini (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: clerkRunDescriptor,
  extractUrl: clerkRunUrl,
  configPath: () => userPath(".gemini", "settings.json"),
});

export const geminiClient = makeCliClient({
  base: geminiFileClient,
  binary: "gemini",
  installHint: "Install the Gemini CLI: https://github.com/google-gemini/gemini-cli",
  addArgs: (name) => [
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "stdio",
    name,
    RUN_COMMAND,
    ...clerkRunArgs(),
  ],
  removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
});
