/**
 * Writes to `~/.codex/config.toml` under the `[mcp_servers.<name>]` table.
 * Codex supports Streamable HTTP MCP servers directly, so the descriptor is
 * just `{ url }` — no `mcp-remote` stdio bridge (unlike Gemini).
 */

import { hasStringProp, makeTomlClient } from "./make-json-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const codexClient = makeTomlClient({
  id: "codex",
  displayName: "Codex",
  scope: "user",
  activation: "Restart Codex; it opens a browser to sign in if the server requires it.",
  topKey: "mcp_servers",
  encode: (url) => ({ url }),
  extractUrl: (d) => (hasStringProp(d, "url") ? d.url : undefined),
  configPath: () => userPath(".codex", "config.toml"),
  detect: () => pathExists(userPath(".codex")),
});
