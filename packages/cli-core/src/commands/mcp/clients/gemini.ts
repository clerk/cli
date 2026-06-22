/**
 * Writes to `~/.gemini/settings.json`. Gemini has no native HTTP transport, so
 * it always needs a stdio bridge — now `clerk mcp run` instead of the previous
 * `npx -y mcp-remote <url>`. Legacy `mcp-remote` entries still round-trip on
 * list/uninstall so existing installs remain manageable.
 */

import { clerkRunArgs, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeJsonClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

// Extract the Clerk MCP URL from a legacy stdio bridge entry of any shape
// (npx mcp-remote, bunx mcp-remote, etc.) by looking for a Clerk URL in args
// rather than matching a specific command name. Matching on the URL is more
// robust than checking the command: the tool that launches the bridge may vary
// (npx, bunx, pnpx…) but the target URL identifies what it connects to.
function extractLegacyBridgeUrl(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const candidate = value as { args?: unknown };
  if (!Array.isArray(candidate.args)) return undefined;
  // Find the last string arg that looks like an https://…clerk.com URL.
  for (let i = candidate.args.length - 1; i >= 0; i--) {
    const arg = candidate.args[i];
    if (typeof arg !== "string") continue;
    try {
      const parsed = new URL(arg);
      if (
        (parsed.hostname === "mcp.clerk.com" || parsed.hostname.endsWith(".clerk.com")) &&
        (parsed.protocol === "https:" || parsed.protocol === "http:")
      ) {
        return parsed.href;
      }
    } catch {
      // not a URL
    }
  }
  return undefined;
}

export const geminiClient = makeJsonClient({
  id: "gemini",
  displayName: "Gemini Code Assist / CLI",
  scope: "user",
  activation: "Restart Gemini (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: () => ({ command: RUN_COMMAND, args: clerkRunArgs() }),
  extractUrl: (d) => withLegacyUrl(d) ?? extractLegacyBridgeUrl(d),
  configPath: () => userPath(".gemini", "settings.json"),
  detect: () => pathExists(userPath(".gemini")),
});
