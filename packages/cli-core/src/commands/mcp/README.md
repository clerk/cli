# `clerk mcp`

Manage the Clerk remote MCP server connection in supported AI clients.

These subcommands register, list, and remove the Clerk entry per client, and
probe the server via `clerk doctor`. Clients that ship a **non-interactive** MCP
registration CLI (Claude Code, Gemini, Codex, VS Code, OpenClaw, Hermes) are
registered by shelling out to it — the client owns its config format and write
safety; for the rest (Cursor, Windsurf, Warp, opencode) we write the config
file directly. Reads (`list`, `doctor`, the uninstall picker) always parse the
config files directly. The server URL defaults to Clerk's hosted server
(`https://mcp.clerk.com/mcp`), so `clerk mcp install` works out of the box with
no flags or profile setup (see [Development](#development) for the override
order).

No Clerk API endpoints are called. To verify the server is reachable, run
`clerk doctor` — its MCP check performs the `initialize` handshake against each
distinct configured URL whenever a Clerk MCP entry is installed.

## Supported clients

All entries are written to each client's **user-global** config, so the server
is available in every project (no per-project approval, no dependence on which
directory you run the CLI from).

| ID                   | Client                   | Registered via                              | Removed via          | Config file (read for `list`/`doctor`)        |
| -------------------- | ------------------------ | ------------------------------------------- | -------------------- | --------------------------------------------- |
| `claude`             | Claude Code              | `claude mcp add --scope user`               | `claude mcp remove`  | `~/.claude.json` (`mcpServers`)               |
| `cursor`             | Cursor                   | direct file write (no CLI exists)           | direct file write    | `~/.cursor/mcp.json`                          |
| `vscode` (`copilot`) | GitHub Copilot (VS Code) | `code --add-mcp '<json>'`                   | direct file write    | VS Code user `mcp.json` (per-OS, below)       |
| `windsurf`           | Windsurf                 | direct file write (no CLI exists)           | direct file write    | `~/.codeium/windsurf/mcp_config.json`         |
| `gemini`             | Gemini Code Assist / CLI | `gemini mcp add --scope user`               | `gemini mcp remove`  | `~/.gemini/settings.json`                     |
| `codex`              | Codex                    | `codex mcp add`                             | `codex mcp remove`   | `~/.codex/config.toml` (`mcp_servers`)        |
| `opencode`           | opencode                 | direct file write (CLI is interactive-only) | direct file write    | `opencode.json` in the XDG config dir (`mcp`) |
| `openclaw`           | OpenClaw                 | `openclaw mcp add --no-probe`               | `openclaw mcp unset` | `~/.openclaw/openclaw.json` (`mcp.servers`)   |
| `warp`               | Warp                     | direct file write (no CLI exists)           | direct file write    | `~/.warp/.mcp.json`                           |
| `hermes`             | Hermes Agent             | `hermes mcp add`                            | `hermes mcp remove`  | `~/.hermes/config.yaml` (`mcp_servers`)       |

For CLI-registered clients there is **no file-write fallback**: if the client's
binary isn't on PATH (e.g. VS Code without the `code` shell command installed),
that client fails with an actionable error (`mcp_client_cli_not_found`), and
detection treats the client as absent — the picker and `--all` only offer
clients whose CLI can actually be driven. Client CLIs are spawned with stdin
closed and a 15s timeout, so a CLI that tries to prompt fails cleanly instead
of hanging agent-mode runs.

GitHub Copilot's MCP server lives in VS Code's config, so `--client copilot` and
`--client vscode` are aliases for the same client. VS Code has an add CLI but no
removal counterpart, so `uninstall` (and the pre-clean before a re-install)
edits its `mcp.json` directly. Its user config dir is OS-specific:
`~/Library/Application Support/Code/User/mcp.json` (macOS),
`%APPDATA%\Code\User\mcp.json` (Windows), `$XDG_CONFIG_HOME/Code/User/mcp.json`
(Linux) — the file behind **MCP: Open User Configuration**.

**Configs owned by a client's CLI are read-only to us.** The file layer exists
for two different jobs: _reads_ (every client — `list`, `doctor`, and the
presence checks parse the config files, because no client CLI offers a stable
machine-readable listing) and _writes_ (only the clients with no usable
registration CLI: Cursor, Windsurf, Warp, opencode — plus VS Code's
removal, since its CLI is add-only). For every CLI-delegated client
(Claude Code, Gemini, Codex, OpenClaw, Hermes) the file base is built
read-only and a write reaching it throws — Codex is the one TOML-backed
client (`[mcp_servers.<name>]`), Hermes the one YAML-backed client (`--args`
is passed last to its CLI because it swallows the rest of the argv).

Per-client dialect notes:

- **opencode** does ship an `mcp add` command, but it is an interactive wizard
  with no flag-driven stdio path (and no remove command), so it counts as
  file-backed. It nests entries under top-level `mcp` and uses a single argv
  array: `{ "type": "local", "command": ["clerk", "mcp", "run"] }`. Its config
  root follows XDG on every platform: `$XDG_CONFIG_HOME/opencode/opencode.json`
  (default `~/.config/opencode/opencode.json`) on macOS/Linux,
  `%APPDATA%\opencode\opencode.json` on Windows.
- **OpenClaw** nests its server map at `mcp.servers.<name>`. `add` is passed
  `--no-probe` because OpenClaw test-connects new servers by default and the
  hosted Clerk server requires OAuth — the probe would fail an otherwise valid
  registration. Its `unset` errors on a missing name, so removal is skipped
  when our read shows no entry.
- **Warp** ships no registration CLI (its `oz` CLI only attaches servers to
  cloud-agent runs); `~/.warp/.mcp.json` is the documented file surface behind
  `Settings → Agents → MCP servers`, standard `mcpServers` dialect.
- **Hermes** `mcp add` probes the server and then ends in a confirm prompt
  ("Enable all tools?" on success, "Save config anyway?" on failure) — and
  cancelling on EOF exits **0** without saving. The CLI is therefore driven
  with the affirmative answer piped to stdin, and after add we re-read the
  config and fail with `mcp_client_cli_failed` if the entry didn't land, since
  the exit code alone can't be trusted. `hermes mcp remove` takes its default
  (yes) on EOF, so removal needs no piped input.

## How clients connect (the stdio bridge)

Every client installs the same stdio descriptor — it launches `clerk mcp run`
rather than pointing the editor at the remote URL directly:

```jsonc
{ "command": "clerk", "args": ["mcp", "run"] }
```

`clerk mcp run` ([run.ts](./run.ts)) is a stdio↔Streamable-HTTP proxy — the same
job `npx mcp-remote` does, but built into the CLI so there's no npx dependency
and the bridge is pinned to the installed CLI version. Because the wiring lives
in the CLI, future auth support lands against this same command with no
re-install. `clerk` must be on the editor's `PATH`.

VS Code tags the entry with `"type": "stdio"`; opencode uses its
`{ "type": "local", "command": [argv…] }` dialect; the others use the plain
shape above. Codex writes the equivalent TOML (`command`/`args` under
`[mcp_servers.<name>]`) and Hermes' CLI writes the equivalent YAML.

> **Auth (current limitation):** `clerk mcp run` is transport-only today — it
> does not perform OAuth. Against an auth-required server (including the hosted
> `mcp.clerk.com`) it surfaces a clear error rather than signing in. Set
> `CLERK_MCP_URL` to a server that doesn't require auth (e.g. a local worker at
> `http://localhost:8787/mcp`) until built-in sign-in ships.

## Subcommands

### `clerk mcp install`

Register the Clerk MCP server in one or more clients.

| Flag            | Description                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--client <id>` | Target a specific client. Repeat for multiple. Default in agent mode: all detected. Default in human mode: interactive multiselect over detected clients. |
| `--all`         | Install into every detected client without prompting.                                                                                                     |
| `--name <name>` | Entry key in the client config. Default: `clerk`.                                                                                                         |
| `--json`        | Emit a JSON summary on stdout instead of human-formatted output.                                                                                          |

**Install always converges:** whatever entry currently sits under `--name`
(a legacy shape, a stale URL, an unrelated server that happens to share the
name) is replaced with the current bridge entry. For CLI-registered clients
this is a best-effort `remove` followed by `add` through the client's own CLI
(so re-install works no matter how the CLI treats duplicate names); for
file-backed clients the entry is overwritten in place. Success reports
`status: installed` per client. Failures are warned per client on stderr and
listed in the `--json` output's `failures` array (`{ client, error }`);
`uninstall --json` reports the same shape. The command exits non-zero only
when every targeted client fails — and in `--json` mode the
`{ results, failures }` envelope is still emitted on stdout in that case (the
exit code carries the failure), so machine consumers always get the structured
output.

**After install:** registering the entry does not connect the server on its
own. In human mode, `install` prints per-client next steps — the server only
goes live once you **reload the editor**, which then spawns `clerk mcp run`
(so `clerk` must be on the editor's `PATH`).

> **Concurrent writes:** for CLI-registered clients, write safety is the
> client's own responsibility — its CLI owns the config. The file-backed
> clients (Cursor, Windsurf, VS Code removal) are written atomically (temp
> file + rename), which prevents a torn read but not a lost update if the
> editor rewrites its own config concurrently — those writes are safest with
> the target client closed.

### `clerk mcp list`

Print every Clerk MCP entry across all supported clients: any `clerk mcp run`
bridge entry, matched by its descriptor shape regardless of its name or
currently-resolved URL (plus, for opencode's remote dialect, entries named
`clerk` or pointing at a `*.clerk.com` host). Entries this CLI never wrote —
e.g. a hand-added direct-URL entry — are left alone. The `--json` (and
agent-mode) output is `{ entries, failures }`: a client whose config exists but
can't be read or parsed appears in `failures` (`{ client, error }`) rather than
being silently folded into "no entries" — the same structural-failure contract
as `install`/`uninstall`. In human mode, an unreadable config downgrades the
"nothing installed" hint to a "could not be read" warning.

### `clerk mcp run`

The stdio bridge that installed clients spawn — **not meant to be run by hand**.
It reads newline-delimited JSON-RPC from stdin, forwards each message to the
remote server over the Streamable HTTP transport (POST; JSON or SSE responses),
threads the `Mcp-Session-Id`, opens the optional server→client SSE stream, and
writes replies to stdout. stdout carries **only** JSON-RPC frames; all
diagnostics go to stderr. It takes no flags — the server URL is resolved from
`CLERK_MCP_URL` / the active env profile / the hosted default at spawn time.

Transport-only: a `401`/`403` from the upstream before a session exists (the
initial handshake) throws `mcp_client_config_invalid` and kills the bridge;
once a session id exists, the same status is instead answered per-request as a
JSON-RPC error (`-32001`, "requires authentication") and the bridge keeps
running.

### `clerk mcp uninstall`

Remove the entry. For CLI-registered clients (claude, gemini, codex, openclaw,
hermes), removal runs the client's own remove command; when our read of the
config shows no entry, `removed: false` is reported without invoking any CLI,
and when the entry is present but the client's binary is missing, that client
fails with `mcp_client_cli_not_found`. After the remove command reports
success, the config is re-read — if the entry is somehow still present, the
client fails with `mcp_client_cli_failed` rather than reporting a removal that
didn't happen (the mirror of the add-side `verifyAdd` check). Cursor, Windsurf, Warp, opencode, and
VS Code (add-only CLI) are removed by editing the config file directly.

In human mode with no `--client`/`--all`, it prompts with a
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
> any is unreachable). A `401`/`403` answer counts as reachable — the server is
> there, it just gates the handshake behind the OAuth flow the editor runs
> itself — and is reported as "authentication required".

## Development

The hosted server's source lives at
[clerk/cloudflare-workers/workers/remote-mcp-server](https://github.com/clerk/cloudflare-workers/tree/main/workers/remote-mcp-server).
The URL every subcommand (and the bridge at spawn time) targets is resolved in
order: the `CLERK_MCP_URL` environment variable > the active environment
profile's `mcpUrl` field (`switch-env` carries the profile value
automatically) > Clerk's hosted server (`https://mcp.clerk.com/mcp`).
`CLERK_MCP_URL` is the convenient override when developing the worker locally
(e.g. `http://localhost:8787/mcp`).

## Error codes

Errors that block registration (`mcp_no_client_detected`,
`mcp_client_cli_not_found`, `mcp_client_cli_failed`) carry a `docsUrl` pointing
at the [Clerk MCP server docs](https://clerk.com/docs/guides/ai/mcp/clerk-mcp-server),
which document per-client manual setup — the fallback path when the CLI can't
drive a client (agent mode receives the raw-markdown `.md` variant).

| Code                        | Meaning                                                                   |
| --------------------------- | ------------------------------------------------------------------------- |
| `mcp_no_client_detected`    | No supported client found on the system.                                  |
| `mcp_client_not_supported`  | `--client <id>` is not in the supported list.                             |
| `mcp_client_config_invalid` | An existing client config file is malformed.                              |
| `mcp_url_required`          | The resolved MCP URL is malformed or uses a non-http(s) scheme.           |
| `mcp_client_cli_not_found`  | The client's own CLI (e.g. `claude`, `code`) is not on PATH.              |
| `mcp_client_cli_failed`     | The client's own CLI exited non-zero or timed out during register/remove. |
