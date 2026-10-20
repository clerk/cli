/**
 * Registration is delegated to OpenClaw's own CLI:
 * `openclaw mcp add <name> --url <url> --transport streamable-http --auth oauth --no-probe`.
 * `--no-probe` skips OpenClaw's default test-connect on add — the hosted
 * server requires OAuth, and the user hasn't signed in yet, so probing would
 * fail an otherwise valid registration. Removal via `openclaw mcp unset <name>`
 * (errors on a missing name, but the factory's presence check skips the CLI
 * in that case). The file-backed base reads `~/.openclaw/openclaw.json` —
 * server map nested at `mcp.servers.<name>` — for `list`/`doctor`.
 */

import { makeCliClient } from "./make-cli-client.ts";
import { makeReadOnlyJsonClient, urlField } from "./make-client.ts";
import { userPath } from "./paths.ts";

const openclawFileClient = makeReadOnlyJsonClient({
  id: "openclaw",
  displayName: "OpenClaw",
  scope: "user",
  activation: (name) =>
    `Run \`openclaw mcp login ${name}\` to sign in to Clerk, then restart OpenClaw.`,
  topKey: ["mcp", "servers"],
  encode: (url) => ({ url, transport: "streamable-http", auth: "oauth" }),
  extractUrl: urlField("url"),
  configPath: () => userPath(".openclaw", "openclaw.json"),
});

export const openclawClient = makeCliClient({
  base: openclawFileClient,
  binary: "openclaw",
  installHint: "Install OpenClaw: https://openclaw.ai",
  addArgs: ({ name, url }) => [
    "mcp",
    "add",
    name,
    "--url",
    url,
    "--transport",
    "streamable-http",
    "--auth",
    "oauth",
    "--no-probe",
  ],
  removeArgs: (name) => ["mcp", "unset", name],
});
