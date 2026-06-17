/**
 * Writes to `~/.codex/config.toml` under the `[mcp_servers.<name>]` table.
 * Installs the `clerk mcp run` stdio bridge (`command` + `args`); legacy bare
 * `{ url }` entries still round-trip on list/uninstall.
 */

import { clerkRunArgs, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeTomlClient } from "./make-client.ts";
import { pathExists, userPath } from "./paths.ts";

export const codexClient = makeTomlClient({
  id: "codex",
  displayName: "Codex",
  scope: "user",
  activation: "Restart Codex (`clerk` must be on your PATH).",
  topKey: "mcp_servers",
  encode: (url) => ({ command: RUN_COMMAND, args: clerkRunArgs(url) }),
  extractUrl: (d) => withLegacyUrl(d),
  configPath: () => userPath(".codex", "config.toml"),
  detect: () => pathExists(userPath(".codex")),
});
