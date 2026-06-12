/**
 * Writes to `~/.gemini/settings.json`. Gemini doesn't support HTTP transport
 * directly — it requires `mcp-remote` as a stdio bridge, hence the
 * `{ command: "npx", args: ["-y", "mcp-remote", <url>] }` shape.
 */

import { makeJsonClient } from "./make-json-client.ts";
import { pathExists, userPath } from "./paths.ts";

interface McpRemoteEntry {
  command: string;
  args: [string, string, string, ...string[]];
}

// Match the exact shape we wrote: `{command: "npx", args: ["-y", "mcp-remote", <url>]}`.
// Permissive matching ("last arg of any args[]") would round-trip unrelated
// stdio bridges as if they were Clerk MCP entries.
function isMcpRemoteEntry(value: unknown): value is McpRemoteEntry {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { command?: unknown; args?: unknown };
  if (candidate.command !== "npx") return false;
  if (!Array.isArray(candidate.args) || candidate.args.length < 3) return false;
  if (!candidate.args.every((a) => typeof a === "string")) return false;
  return candidate.args[0] === "-y" && candidate.args[1] === "mcp-remote";
}

export const geminiClient = makeJsonClient({
  id: "gemini",
  displayName: "Gemini Code Assist / CLI",
  scope: "user",
  activation:
    "Restart Gemini (needs `npx` on PATH); `mcp-remote` opens a browser to sign in if the server requires it.",
  topKey: "mcpServers",
  encode: (url) => ({ command: "npx", args: ["-y", "mcp-remote", url] }),
  extractUrl: (d) => (isMcpRemoteEntry(d) ? d.args[2] : undefined),
  configPath: () => userPath(".gemini", "settings.json"),
  detect: () => pathExists(userPath(".gemini")),
});
