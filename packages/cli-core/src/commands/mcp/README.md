# `clerk mcp`

Manage the Clerk remote MCP server connection in supported AI clients.

The Clerk MCP server is hosted at `https://mcp.clerk.com/mcp` (source:
[clerk/cloudflare-workers/workers/remote-mcp-server](https://github.com/clerk/cloudflare-workers/tree/main/workers/remote-mcp-server)).
These subcommands register, list, remove, and probe that URL in each client's
own config file. The URL is resolved in order: `--url` > the `CLERK_MCP_URL`
environment variable > the active environment profile's `mcpUrl` field
(`switch-env` carries the profile value automatically). `CLERK_MCP_URL` is the
convenient override when developing the worker locally (e.g.
`http://localhost:8787/mcp`).

No Clerk API endpoints are called. To verify the server is reachable, run
`clerk doctor` — its MCP check performs the `initialize` handshake against the
configured URL whenever a Clerk MCP entry is installed.

## Supported clients

| ID            | Client                   | Scope   | Config file                           |
| ------------- | ------------------------ | ------- | ------------------------------------- |
| `claude-code` | Claude Code              | project | `<cwd>/.mcp.json`                     |
| `cursor`      | Cursor                   | project | `<cwd>/.cursor/mcp.json`              |
| `vscode`      | VS Code (Copilot)        | project | `<cwd>/.vscode/mcp.json`              |
| `windsurf`    | Windsurf                 | user    | `~/.codeium/windsurf/mcp_config.json` |
| `gemini`      | Gemini Code Assist / CLI | user    | `~/.gemini/settings.json`             |

## Subcommands

### `clerk mcp install`

Register the Clerk MCP server in one or more clients.

| Flag            | Description                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--client <id>` | Target a specific client. Repeat for multiple. Default in agent mode: all detected. Default in human mode: interactive multiselect over detected clients. |
| `--all`         | Install into every detected client without prompting.                                                                                                     |
| `--url <url>`   | Override the MCP URL. Defaults to the active env profile's `mcpUrl`.                                                                                      |
| `--name <name>` | Entry key in the client config. Default: `clerk`.                                                                                                         |
| `--force`       | Overwrite an entry already pointing at a different URL. Without it, the conflict is reported and skipped.                                                 |
| `--json`        | Emit a JSON summary on stdout instead of human-formatted output.                                                                                          |

**Conflict policy:** if an entry with the same `--name` already exists and
points at the same URL, the install is a silent no-op (`status: unchanged`).
If it points at a different URL, the install is skipped with a `reason`
unless `--force` is passed.

**After install:** writing the config does not connect the server on its own.
In human mode, `install` prints per-client next steps — the server only goes
live once you **reload the editor**. If the server requires authentication, the
editor opens a browser to **sign in** on first connect. Gemini additionally
needs `npx` on `PATH`, since its entry launches `mcp-remote` as a stdio bridge.

### `clerk mcp list`

Print every Clerk-flavored MCP entry across all supported clients (entries
named `clerk` or pointing at any `*.clerk.com` host).

### `clerk mcp uninstall`

Remove the named entry from each client. Throws `mcp_not_installed` (exit
code 1) when nothing was removed. Removing the entry doesn't drop a live editor
session, so (in human mode) it prints a next step to reload each affected editor.

> **Reachability:** there is no `mcp doctor` subcommand. Server health is part
> of `clerk doctor`, which probes the configured MCP URL via the `initialize`
> handshake when an entry is installed (warns, does not fail, when unreachable).

## Error codes

| Code                        | Meaning                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `mcp_no_client_detected`    | No supported client found on the system.                        |
| `mcp_client_not_supported`  | `--client <id>` is not in the supported list.                   |
| `mcp_client_config_invalid` | An existing client config file is malformed.                    |
| `mcp_url_required`          | No `--url` provided and the active env profile has no `mcpUrl`. |
| `mcp_not_installed`         | `uninstall` removed nothing because no entry matched.           |
