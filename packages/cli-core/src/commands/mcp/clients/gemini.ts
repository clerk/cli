/**
 * Writes to `~/.gemini/settings.json`. Gemini has no native HTTP transport, so
 * it always needs a stdio bridge — now `clerk mcp run` instead of the previous
 * `npx -y mcp-remote <url>`. Legacy `mcp-remote` entries still round-trip on
 * list/uninstall so existing installs remain manageable.
 */

import { clerkRunArgs, extractClerkRunUrl, RUN_COMMAND } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

interface McpRemoteEntry {
  command: string;
  args: [string, string, string, ...string[]];
}

// Match the exact legacy shape `{command: "npx", args: ["-y", "mcp-remote", <url>]}`.
// Permissive matching would round-trip unrelated stdio bridges as Clerk entries.
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
  activation: "Restart Gemini (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: (url) => ({ command: RUN_COMMAND, args: clerkRunArgs(url) }),
  extractUrl: (d) => extractClerkRunUrl(d) ?? (isMcpRemoteEntry(d) ? d.args[2] : undefined),
  configPath: () => userPath(".gemini", "settings.json"),
  detect: () => pathExists(userPath(".gemini")),
});
