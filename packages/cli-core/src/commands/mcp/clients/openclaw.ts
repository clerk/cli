/**
 * Registration is delegated to OpenClaw's own CLI:
 * `openclaw mcp add <name> --command clerk --arg mcp --arg run --no-probe`.
 * `--no-probe` skips OpenClaw's default test-connect on add — the hosted
 * server requires OAuth, so probing would fail an otherwise valid
 * registration. Removal via `openclaw mcp unset <name>` (errors on a missing
 * name, but the factory's presence check skips the CLI in that case). The
 * file-backed base reads `~/.openclaw/openclaw.json` — server map nested at
 * `mcp.servers.<name>` — for `list`/`doctor`.
 */

import { clerkRunArgs, clerkRunDescriptor, RUN_COMMAND, withLegacyUrl } from "./clerk-run.ts";
import { makeCliClient } from "./make-cli-client.ts";
import { makeReadOnlyJsonClient } from "./make-client.ts";
import { userPath } from "./paths.ts";

const openclawFileClient = makeReadOnlyJsonClient({
  id: "openclaw",
  displayName: "OpenClaw",
  scope: "user",
  activation: "Restart OpenClaw (`clerk` must be on your PATH).",
  topKey: ["mcp", "servers"],
  encode: clerkRunDescriptor,
  extractUrl: withLegacyUrl,
  configPath: () => userPath(".openclaw", "openclaw.json"),
});

export const openclawClient = makeCliClient({
  base: openclawFileClient,
  binary: "openclaw",
  installHint: "Install OpenClaw: https://openclaw.ai",
  addArgs: (name) => [
    "mcp",
    "add",
    name,
    "--command",
    RUN_COMMAND,
    ...clerkRunArgs().flatMap((arg) => ["--arg", arg]),
    "--no-probe",
  ],
  removeArgs: (name) => ["mcp", "unset", name],
});
