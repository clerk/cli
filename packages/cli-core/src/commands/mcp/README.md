# `clerk mcp`

Manage the Clerk remote MCP server connection in supported AI clients.

The Clerk MCP server is hosted at `https://mcp.clerk.com/mcp` (source:
[clerk/cloudflare-workers/workers/remote-mcp-server](https://github.com/clerk/cloudflare-workers/tree/main/workers/remote-mcp-server)).
These subcommands register, list, remove, and probe that URL in each client's
own config file. The URL is resolved in order: `--url` > the `CLERK_MCP_URL`
environment variable > the active environment profile's `mcpUrl` field
(`switch-env` carries the profile value automatically) > Clerk's hosted server
(`https://mcp.clerk.com/mcp`). Because the hosted server is the final fallback,
`clerk mcp install` works out of the box with no flags or profile setup.
`CLERK_MCP_URL` is the convenient override when developing the worker locally
(e.g. `http://localhost:8787/mcp`).

No Clerk API endpoints are called. To verify the server is reachable, run
`clerk doctor` — its MCP check performs the `initialize` handshake against each
distinct configured URL whenever a Clerk MCP entry is installed.

## Supported clients

All entries are written to each client's **user-global** config, so the server
is available in every project (no per-project approval, no dependence on which
directory you run the CLI from).

| ID                   | Client                   | Scope | Config file                             |
| -------------------- | ------------------------ | ----- | --------------------------------------- |
| `claude`             | Claude Code              | user  | `~/.claude.json` (`mcpServers`)         |
| `cursor`             | Cursor                   | user  | `~/.cursor/mcp.json`                    |
| `vscode` (`copilot`) | GitHub Copilot (VS Code) | user  | VS Code user `mcp.json` (per-OS, below) |
| `windsurf`           | Windsurf                 | user  | `~/.codeium/windsurf/mcp_config.json`   |
| `gemini`             | Gemini Code Assist / CLI | user  | `~/.gemini/settings.json`               |
| `codex`              | Codex                    | user  | `~/.codex/config.toml` (`mcp_servers`)  |

GitHub Copilot's MCP server lives in VS Code's config, so `--client copilot` and
`--client vscode` are aliases for the same client. Its user config dir is
OS-specific: `~/Library/Application Support/Code/User/mcp.json` (macOS),
`%APPDATA%\Code\User\mcp.json` (Windows), `$XDG_CONFIG_HOME/Code/User/mcp.json`
(Linux) — the file behind **MCP: Open User Configuration**.

Codex is the one TOML-backed client; the entry uses Codex's native Streamable
HTTP transport (`url = "…"` under `[mcp_servers.<name>]`), so it needs no
`mcp-remote` bridge. Rewriting `config.toml` does not preserve comments.

## Subcommands

### `clerk mcp install`

Register the Clerk MCP server in one or more clients.

| Flag            | Description                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--client <id>` | Target a specific client. Repeat for multiple. Default in agent mode: all detected. Default in human mode: interactive multiselect over detected clients. |
| `--all`         | Install into every detected client without prompting.                                                                                                     |
| `--url <url>`   | Override the MCP URL. Defaults to the active env profile's `mcpUrl`, then Clerk's hosted server.                                                          |
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

Remove the entry. In human mode with no `--client`/`--all`, it prompts with a
multiselect of the clients that **currently have the entry**, all unchecked:
check the clients to remove the entry from and leave the rest unchecked, so the
default (nothing checked) removes nothing. `--all` removes from every client
without prompting; agent mode targets all clients; `--client <id>` (repeatable)
targets specific clients. When nothing matches, it prints a warm hint to run
`clerk mcp install` (no error, exit 0). Removing the entry doesn't drop a live
editor session, so (in human mode) it prints a next step to reload each affected
editor.

> **Reachability:** there is no `mcp doctor` subcommand. Server health is part
> of `clerk doctor`, which probes each distinct configured MCP URL via the
> `initialize` handshake when an entry is installed (warns, does not fail, when
> any is unreachable).

## Error codes

| Code                        | Meaning                                                         |
| --------------------------- | --------------------------------------------------------------- |
| `mcp_no_client_detected`    | No supported client found on the system.                        |
| `mcp_client_not_supported`  | `--client <id>` is not in the supported list.                   |
| `mcp_client_config_invalid` | An existing client config file is malformed.                    |
| `mcp_url_required`          | The provided `--url` is malformed or uses a non-http(s) scheme. |
