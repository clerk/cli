/**
 * Registration is delegated to Codex's own CLI:
 * `codex mcp add … -- clerk mcp run` (Codex's config is global, no scope
 * flag). The file-backed base still reads `~/.codex/config.toml`
 * (`[mcp_servers.<name>]`) for `list`/`doctor`.
 */

import { clerkRunArgs, clerkRunDescriptor, clerkRunUrl, RUN_COMMAND } from "./clerk-run.ts";
import { makeCliClient } from "./make-cli-client.ts";
import { makeTomlClient } from "./make-client.ts";
import { userPath } from "./paths.ts";

const codexFileClient = makeTomlClient({
  id: "codex",
  displayName: "Codex",
  scope: "user",
  activation: "Restart Codex (`clerk` must be on your PATH).",
  topKey: "mcp_servers",
  encode: clerkRunDescriptor,
  extractUrl: clerkRunUrl,
  configPath: () => userPath(".codex", "config.toml"),
});

export const codexClient = makeCliClient({
  base: codexFileClient,
  binary: "codex",
  installHint: "Install the Codex CLI: https://github.com/openai/codex",
  addArgs: (name) => ["mcp", "add", name, "--", RUN_COMMAND, ...clerkRunArgs()],
  removeArgs: (name) => ["mcp", "remove", name],
});
