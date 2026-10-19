/**
 * Registration is delegated to Gemini's own CLI:
 * `gemini mcp add --scope user --transport http <name> <url>`. The
 * file-backed base still reads `~/.gemini/settings.json` (rooted at
 * `$GEMINI_CLI_HOME` when set) for `list`/`doctor`. Current Gemini CLIs save
 * Streamable HTTP servers as `{ url, type: "http" }`; older ones used
 * `httpUrl`. Both are read back.
 */

import { makeCliClient } from "./make-cli-client.ts";
import { makeReadOnlyJsonClient, urlField } from "./make-client.ts";
import { geminiSettingsPath } from "./paths.ts";

const readHttpUrl = urlField("httpUrl");
const readUrl = urlField("url");

const geminiFileClient = makeReadOnlyJsonClient({
  id: "gemini",
  displayName: "Gemini Code Assist / CLI",
  scope: "user",
  activation: (name) => `Restart Gemini, then run \`/mcp auth ${name}\` to sign in to Clerk.`,
  topKey: "mcpServers",
  encode: (url) => ({ url, type: "http" }),
  extractUrl: (descriptor) => readHttpUrl(descriptor) ?? readUrl(descriptor),
  configPath: geminiSettingsPath,
});

export const geminiClient = makeCliClient({
  base: geminiFileClient,
  binary: "gemini",
  installHint: "Install the Gemini CLI: https://github.com/google-gemini/gemini-cli",
  addArgs: ({ name, url }) => ["mcp", "add", "--scope", "user", "--transport", "http", name, url],
  removeArgs: (name) => ["mcp", "remove", "--scope", "user", name],
});
