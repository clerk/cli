/**
 * Registration is delegated to Gemini's own CLI:
 * `gemini mcp add --scope user --transport stdio … clerk mcp run`. The
 * file-backed base still reads `~/.gemini/settings.json` for `list`/`doctor`.
 * Gemini has no native HTTP transport, so it always needs the stdio bridge —
 * `clerk mcp run` today, previously `npx -y mcp-remote <url>`; legacy
 * `mcp-remote` entries still round-trip on list/uninstall.
 */

import { isRecord } from "../../../lib/objects.ts";
import { clerkRunArgs, clerkRunDescriptor, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeCliClient } from "./make-cli-client.ts";
import { isClerkHost, makeReadOnlyJsonClient } from "./make-client.ts";
import { userPath } from "./paths.ts";

// Extract the Clerk MCP URL from a legacy stdio bridge entry of any shape
// (npx mcp-remote, bunx mcp-remote, etc.) by looking for a Clerk URL in args
// rather than matching a specific command name. Matching on the URL is more
// robust than checking the command: the tool that launches the bridge may vary
// (npx, bunx, pnpx…) but the target URL identifies what it connects to.
function extractLegacyBridgeUrl(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const candidate = value as { args?: unknown };
  if (!Array.isArray(candidate.args)) return undefined;
  // Find the last string arg that looks like an https://…clerk.com URL.
  for (let i = candidate.args.length - 1; i >= 0; i--) {
    const arg = candidate.args[i];
    if (typeof arg !== "string") continue;
    try {
      const parsed = new URL(arg);
      if (
        isClerkHost(parsed.hostname) &&
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

const geminiFileClient = makeReadOnlyJsonClient({
  id: "gemini",
  displayName: "Gemini Code Assist / CLI",
  scope: "user",
  activation: "Restart Gemini (`clerk` must be on your PATH).",
  topKey: "mcpServers",
  encode: clerkRunDescriptor,
  extractUrl: (d) => withLegacyUrl(d) ?? extractLegacyBridgeUrl(d),
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
