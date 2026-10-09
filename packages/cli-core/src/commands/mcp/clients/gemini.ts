/**
 * Registration is delegated to Gemini's own CLI:
 * `gemini mcp add --scope user --transport http <name> <url>`. The
 * file-backed base still reads `~/.gemini/settings.json` for `list`/`doctor`.
 * Gemini stores Streamable HTTP servers under `httpUrl` — its `url` key means
 * SSE — so that is the key read back.
 */

import { makeCliClient } from "./make-cli-client.ts";
import { makeReadOnlyJsonClient, urlField } from "./make-client.ts";
import { userPath } from "./paths.ts";

const geminiFileClient = makeReadOnlyJsonClient({
  id: "gemini",
  displayName: "Gemini Code Assist / CLI",
  scope: "user",
  activation: (name) => `Restart Gemini, then run \`/mcp auth ${name}\` to sign in to Clerk.`,
  topKey: "mcpServers",
  encode: (url) => ({ httpUrl: url }),
  extractUrl: urlField("httpUrl"),
  configPath: () => userPath(".gemini", "settings.json"),
});

export const geminiClient = makeCliClient({
  base: geminiFileClient,
  binary: "gemini",
  installHint: "Install the Gemini CLI: https://github.com/google-gemini/gemini-cli",
  addArgs: ({ name, url }) => ["mcp", "add", "--scope", "user", "--transport", "http", name, url],
  removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
});
