# `clerk mcp`

Manage the Clerk remote MCP server connection in supported AI clients.

These subcommands register, list, and remove the Clerk entry per client, and
probe the server via `clerk doctor`. Every client gets a native **Streamable
HTTP** entry pointing at the server URL, and runs the OAuth sign-in to Clerk
itself, so nothing of ours runs at connect time. Clients that ship a
**non-interactive** MCP registration CLI (Claude Code, Gemini, VS Code,
OpenClaw, Hermes) are registered by shelling out to it — the client owns its
config format and write safety. For the others (Cursor, Windsurf, Warp,
opencode, fx) we write the config file directly; Codex is removed through its
CLI but added by a direct write (see its dialect note). Reads (`list`,
`doctor`, the uninstall picker) always parse the config files directly. The
server URL defaults to Clerk's hosted server (`https://mcp.clerk.com/mcp`), so
`clerk mcp install` works out of the box with no flags or profile setup (see
[Development](#development) for the override order).

No Clerk API endpoints are called. To verify the server is reachable, run
`clerk doctor` — its MCP check performs the `initialize` handshake against each
distinct configured URL whenever a Clerk MCP entry is installed.

> **Upgrading from clerk 3.x:** 3.x installed a `clerk mcp run` stdio bridge
> into each client. The bridge was removed in 4.0 and those entries no longer
> connect. Re-run `clerk mcp install` to replace them with URL entries;
> `clerk mcp list` and `clerk doctor` flag any that remain.

## Supported clients

All entries are written to each client's **user-global** config, so the server
is available in every project (no per-project approval, no dependence on which
directory you run the CLI from).

| ID                   | Client                   | Registered via                                     | Removed via          | Config file and entry (read for `list`/`doctor`)                                   |
| -------------------- | ------------------------ | -------------------------------------------------- | -------------------- | ---------------------------------------------------------------------------------- |
| `claude`             | Claude Code              | `claude mcp add --scope user --transport http`     | `claude mcp remove`  | `~/.claude.json` — `mcpServers.<name> = { type: "http", url }`                     |
| `cursor`             | Cursor                   | direct file write (no CLI exists)                  | direct file write    | `~/.cursor/mcp.json` — `mcpServers.<name> = { url }`                               |
| `vscode` (`copilot`) | GitHub Copilot (VS Code) | `code --add-mcp '<json>'`                          | direct file write    | VS Code user `mcp.json` (per-OS, below) — `servers.<name> = { type: "http", url }` |
| `windsurf`           | Windsurf                 | direct file write (no CLI exists)                  | direct file write    | `~/.codeium/windsurf/mcp_config.json` — `mcpServers.<name> = { serverUrl }`        |
| `gemini`             | Gemini Code Assist / CLI | `gemini mcp add --scope user --transport http`     | `gemini mcp remove`  | `~/.gemini/settings.json` — `mcpServers.<name> = { httpUrl }`                      |
| `codex`              | Codex                    | append to `config.toml` (note below)               | `codex mcp remove`   | `~/.codex/config.toml` — `[mcp_servers.<name>] url = …`                            |
| `opencode`           | opencode                 | direct file write (CLI is interactive-only)        | direct file write    | `opencode.json` in the XDG config dir — `mcp.<name> = { type: "remote", url }`     |
| `openclaw`           | OpenClaw                 | `openclaw mcp add --url … --auth oauth --no-probe` | `openclaw mcp unset` | `~/.openclaw/openclaw.json` — `mcp.servers.<name> = { url, … }`                    |
| `warp`               | Warp                     | direct file write (no CLI exists)                  | direct file write    | `~/.warp/.mcp.json` — `mcpServers.<name> = { url }`                                |
| `hermes`             | Hermes Agent             | `hermes mcp add --url … --auth oauth`              | `hermes mcp remove`  | `~/.hermes/config.yaml` — `mcp_servers.<name> = { url, auth: oauth }`              |
| `fx`                 | fx                       | direct file write (note below)                     | direct file write    | `~/.fx/mcp.json` — `mcp.<name> = { type: "http", url }`                            |

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
machine-readable listing) and _writes_ (only the direct-write
clients: Cursor, Windsurf, Warp, opencode, fx — plus VS Code's
removal, since its CLI is add-only, and Codex's add). For the other
CLI-delegated clients (Claude Code, Gemini, OpenClaw, Hermes) the file base is
built read-only and a write reaching it throws. Codex is the one TOML-backed
client, Hermes the one YAML-backed client.

Per-client dialect notes:

- **Gemini** stores Streamable HTTP servers under `httpUrl`; its `url` key means
  SSE, so a `url` entry would connect with the wrong transport.
- **Codex** is added by appending a `[mcp_servers.<name>]` table to
  `config.toml`, not through `codex mcp add --url`: that command saves the
  entry and then, for an OAuth server like Clerk's, starts a browser sign-in
  and blocks on its callback — which can't complete under our closed-stdin,
  time-limited CLI runs. The append is a text append (the file's comments and
  formatting survive), and the combined document is parsed before anything is
  written, so a corrupt file or a leftover table fails with
  `mcp_client_config_invalid` without touching the file. Any existing entry is
  first removed with `codex mcp remove`. Sign in afterwards with
  `codex mcp login <name>`.
- **opencode** does ship an `mcp add` command, but it is an interactive wizard
  (and there is no remove command), so it counts as file-backed. It nests
  entries under top-level `mcp` with `{ "type": "remote", "url": "…" }`. Its
  config root follows XDG on every platform:
  `$XDG_CONFIG_HOME/opencode/opencode.json` (default
  `~/.config/opencode/opencode.json`) on macOS/Linux,
  `%APPDATA%\opencode\opencode.json` on Windows.
- **OpenClaw** nests its server map at `mcp.servers.<name>`. `add` is passed
  `--no-probe` because OpenClaw test-connects new servers by default and the
  user hasn't signed in yet — the probe would fail an otherwise valid
  registration. Its `unset` errors on a missing name, so removal is skipped
  when our read shows no entry.
- **Warp** ships no registration CLI (its `oz` CLI only attaches servers to
  cloud-agent runs); `~/.warp/.mcp.json` is the documented file surface behind
  `Settings → Agents → MCP servers`, standard `mcpServers` dialect.
- **fx** is registered in the user-global trusted profile `~/.fx/mcp.json` —
  fx 0.0.7 also loads workspace `.mcp.json` servers, but those sit behind
  per-workspace trust approval, while the profile needs none and follows the
  user everywhere. fx does ship a non-interactive registration CLI
  (`fx mcp add --transport http`, verified in fx 0.0.7), but we write the
  file directly anyway: the command is newer than fx's own docs (fx.sh
  documents only the in-session `/mcp` form), so the direct write keeps
  registration working on fx binaries that predate it. fx accepts
  `mcpServers` as a profile alias for `mcp` (ignored whenever `mcp` exists),
  so the client migrates an alias-only profile to canonical `mcp` before any
  read or write — otherwise our written `mcp` would shadow every aliased
  server. fx applies hand-edited (or CLI-written) config via `/mcp reload`
  inside an fx session, or on next start.
- **Hermes** `mcp add` probes the server and then ends in a confirm prompt
  ("Enable all tools?" on success, "Save config anyway?" on failure) — and
  cancelling on EOF exits **0** without saving. The CLI is therefore driven
  with the affirmative answer piped to stdin, and after add we re-read the
  config and fail with `mcp_client_cli_failed` if the entry didn't land, since
  the exit code alone can't be trusted. `hermes mcp remove` takes its default
  (yes) on EOF, so removal needs no piped input.

**Which entries are ours:** an entry named `clerk`, an entry whose URL is on a
`*.clerk.com` host, or one whose URL matches the currently resolved MCP URL (so
a `--name` install against a `CLERK_MCP_URL` override stays visible while that
override is set). A clerk 3.x `clerk mcp run` bridge entry is also ours under
any name, and is reported with `legacy: true`.

## Subcommands

### `clerk mcp install`

Register the Clerk MCP server in one or more clients.

| Flag            | Description                                                                                                                                               |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--client <id>` | Target a specific client. Repeat for multiple. Default in agent mode: all detected. Default in human mode: interactive multiselect over detected clients. |
| `--all`         | Install into every detected client without prompting.                                                                                                     |
| `--name <name>` | Entry key in the client config. Default: `clerk`.                                                                                                         |
| `--json`        | Emit a JSON summary on stdout instead of human-formatted output.                                                                                          |

The resolved URL is embedded in each entry at install time. Switching env
profiles (or changing `CLERK_MCP_URL`) does not move existing entries — re-run
`clerk mcp install` to point them at the new URL.

**Install always converges:** whatever entry currently sits under `--name`
(a legacy `clerk mcp run` bridge, a stale URL, an unrelated server that happens
to share the name) is replaced with the URL entry. For CLI-registered clients
this is a best-effort `remove` followed by `add` through the client's own CLI
(so re-install works no matter how the CLI treats duplicate names); for
file-backed clients the entry is overwritten in place. Success reports
`status: installed` per client, plus `migrated: true` when the replaced entry
was a legacy bridge (human mode notes it on the client's line). Failures are
warned per client on stderr and listed in the `--json` output's `failures`
array (`{ client, error }`); `uninstall --json` reports the same shape. The
command exits non-zero only when every targeted client fails — and in `--json`
mode the `{ results, failures }` envelope is still emitted on stdout in that
case (the exit code carries the failure), so machine consumers always get the
structured output.

**After install:** registering the entry does not connect the server on its
own. In human mode, `install` prints per-client next steps: reload the client,
and sign in to Clerk — most clients prompt on first connect; Codex, Gemini,
OpenClaw, Hermes, and fx have an explicit login command, which the next step
names.

> **Concurrent writes:** for CLI-registered clients, write safety is the
> client's own responsibility — its CLI owns the config. The file-backed
> clients (Cursor, Windsurf, Warp, opencode, fx, VS Code removal, Codex add)
> are written atomically (temp file + rename), which prevents a torn read but
> not a lost update if the client rewrites its own config concurrently —
> those writes are safest with the target client closed.

### `clerk mcp list`

Print every Clerk MCP entry across all supported clients (see "Which entries
are ours" above). Entries this CLI doesn't recognize are left alone. Legacy
`clerk mcp run` entries are shown as `clerk mcp run (legacy)` with a next step
to re-run `clerk mcp install`. The `--json` (and agent-mode) output is
`{ entries, failures }`, each entry `{ client, configPath, name, url, legacy }`
(a legacy entry reports the URL its bridge would have resolved): a client whose
config exists but can't be read or parsed appears in `failures`
(`{ client, error }`) rather than being silently folded into "no entries" — the
same structural-failure contract as `install`/`uninstall`. In human mode, an
unreadable config downgrades the "nothing installed" hint to a "could not be
read" warning.

### `clerk mcp uninstall`

Remove the entry. For CLI-registered clients (claude, gemini, codex, openclaw,
hermes), removal runs the client's own remove command; when our read of the
config shows no entry, `removed: false` is reported without invoking any CLI,
and when the entry is present but the client's binary is missing, that client
fails with `mcp_client_cli_not_found`. After the remove command reports
success, the config is re-read — if the entry is somehow still present, the
client fails with `mcp_client_cli_failed` rather than reporting a removal that
didn't happen (the mirror of the add-side `verifyAdd` check). Cursor, Windsurf, Warp, opencode, fx, and
VS Code (add-only CLI) are removed by editing the config file directly. Legacy
bridge entries are removed the same way.

In human mode with no `--client`/`--all`, it prompts with a
multiselect of the clients that **currently have the entry**, all unchecked:
check the clients to remove the entry from and leave the rest unchecked, so the
default (nothing checked) removes nothing. `--all` removes from every client
without prompting; agent mode targets all clients; `--client <id>` (repeatable)
targets specific clients. When nothing matches, it prints a warm hint to run
`clerk mcp install` (no error, exit 0). Removing the entry doesn't drop a live
editor session, so (in human mode) it prints a next step to reload each affected
editor.

### `clerk mcp run` (removed)

The clerk 3.x stdio bridge. Removed in 4.0 and hidden from help; it remains
only so a client still launching it gets an actionable error. It fails with
`mcp_bridge_removed`, and if the first stdin line is a JSON-RPC request (the
client's `initialize`), it first answers it with a JSON-RPC error (`-32000`)
carrying the same "re-run `clerk mcp install`" message, since many clients
surface protocol errors but not stderr.

> **Reachability:** there is no `mcp doctor` subcommand. Server health is part
> of `clerk doctor`, which probes each distinct configured MCP URL via the
> `initialize` handshake when an entry is installed (warns, does not fail, when
> any is unreachable). A `401`/`403` answer counts as reachable — the server is
> there, it just gates the handshake behind the OAuth flow the client runs
> itself — and is reported as "authentication required". Legacy bridge entries
> are not probed; their presence alone produces a warning with the
> re-install remedy.

## Development

The hosted server's source lives at
[clerk/cloudflare-workers/workers/remote-mcp-server](https://github.com/clerk/cloudflare-workers/tree/main/workers/remote-mcp-server).
The URL every subcommand targets is resolved in order: the `CLERK_MCP_URL`
environment variable > the active environment profile's `mcpUrl` field
(`switch-env` carries the profile value automatically) > Clerk's hosted server
(`https://mcp.clerk.com/mcp`). `CLERK_MCP_URL` is the convenient override when
developing the worker locally (e.g. `http://localhost:8787/mcp`).

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
| `mcp_bridge_removed`        | A client launched the removed `clerk mcp run` bridge.                     |
