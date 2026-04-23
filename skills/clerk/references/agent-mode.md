# Clerk CLI — Agent Mode Reference

The Clerk CLI has a first-class "agent" mode that's designed for non-interactive and AI-driven use. Read this before writing scripts or letting an LLM drive the CLI.

## Sandbox warning semantics

Agent mode and sandboxing are related but not identical:

- **Agent mode** controls non-interactive behavior.
- **Sandboxing** controls whether the CLI can actually reach host-only Clerk
  state and host system capabilities.

In agent mode, the CLI now performs a **best-effort warn-once check** at the
host-sensitive integration boundaries. The first time an invocation hits a
blocked host capability, it emits:

```text
Host-only Clerk state or system capabilities may be unavailable in agent mode. This may be a sandboxed run.
Re-run this command on the host shell before trusting auth, link, env, or API failures.
```

Treat that warning as authoritative. The command may still continue and return
an ordinary Clerk error, but any auth/link/env/config/API/browser/OAuth
failure from that invocation should be treated as suspect until rerun on the
host.

The warning can be triggered by:

- home-directory Clerk config / credential file access
- OS keychain access
- outbound Clerk network requests
- browser launch
- localhost callback server binding for OAuth

If your harness does not obviously look non-interactive, force agent behavior
with `--mode agent` or `CLERK_MODE=agent` so the CLI's non-interactive and
sandbox-warning paths apply deterministically.

## How agent mode is detected

Priority (first match wins):

1. `--mode agent` flag on the command line
2. `CLERK_MODE=agent` environment variable
3. Stdout is not a TTY (piped, redirected, or running under an agent harness)

Force human mode with `--mode human` or `CLERK_MODE=human`. Typical AI-agent invocations automatically land in agent mode because stdout is piped.

## What changes in agent mode

| Behavior                                                         | Human mode                     | Agent mode                                                                                                                                                            |
| ---------------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive pickers (`link` without `--app`, `api` with no args) | Show a TUI picker              | Print structured guidance and exit, or auto-resolve                                                                                                                   |
| `clerk link --app <id>`                                          | Links directly                 | Links directly                                                                                                                                                        |
| `clerk link` without `--app`                                     | Interactive picker / create UI | Tries silent autolink from detected publishable keys; if no deterministic match exists, exits with a usage error telling the caller to pass `--app`                   |
| Confirmation prompts (`unlink`, `config patch`, `api -X DELETE`) | Prompt y/n                     | Require `--yes`, otherwise error                                                                                                                                      |
| `clerk doctor --fix`                                             | Interactively offers fixes     | **Ignored**; output the `remedy` field and let the caller act                                                                                                         |
| `clerk apps list` default output                                 | Table                          | JSON (when piped)                                                                                                                                                     |
| `clerk apps create <name>` output                                | Human-readable summary         | JSON (auto-detected, same as `apps list`); `--json` also works explicitly                                                                                             |
| `clerk open [subpath]`                                           | Opens the browser to the URL   | Does not open a browser. Prints a JSON descriptor (`{url, appId, appName, instanceId, instanceLabel, subpath, opened: false}`) on stdout so the agent can surface it  |
| `clerk auth login` when already authenticated                    | Prompt to re-auth              | Silent no-op                                                                                                                                                          |
| `clerk init`                                                     | Full interactive scaffold flow | Skips the interactive scaffold and either runs non-interactively with `--yes` or, with `--prompt`, emits a short agent handoff pointing the agent at `clerk init -y`. |
| Color / spinners                                                 | Enabled                        | Disabled                                                                                                                                                              |

In addition, sandboxed agent-mode invocations may emit the warning above once
per CLI invocation when a host-sensitive operation is blocked.

**Rule of thumb:** always pass `--yes` for mutations, `--json` for structured output where available, and `--app` / `--instance` explicitly instead of relying on pickers.

## Exit codes

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | Success                                                                      |
| `1`  | Runtime error (auth failure, API error, file I/O, etc.)                      |
| `2`  | Usage or validation error (bad flags, malformed JSON body, unknown endpoint) |

`clerk doctor` exits `1` when any check fails (warnings alone still exit `0`).

## Error output format

**Human mode:**

- Single-line error message on stderr.
- Stack traces hidden unless `--verbose` is passed.
- API errors include the first message from the response body, prefixed with a human context string (e.g., `Failed to fetch config: unauthorized`).

**Agent mode:**

- Structured JSON on stderr: `{"error":{"code":"...","message":"...","docsUrl?":"...","errors?":[...]}}`.
- `code` is a machine-readable error code (e.g., `auth_required`, `api_error`, `unexpected_error`).
- `errors` array is present for API errors and mirrors the Clerk API error shape (`{code?, message?, meta?}`).
- `docsUrl` is present when the error has associated documentation.

**Both modes:**

- User-aborted commands exit cleanly with no error output.
- When handling errors programmatically, read stderr, check the exit code, and re-run with `--verbose` to get a trace if you need to debug.

## Structured outputs you can rely on

| Command                      | Structured output                                                                       |
| ---------------------------- | --------------------------------------------------------------------------------------- |
| `clerk doctor --json`        | `[{name, status, message, detail?, remedy?, fix?}]`                                     |
| `clerk apps list --json`     | Array of application objects                                                            |
| `clerk apps create --json`   | Single application object                                                               |
| `clerk api <path>`           | Raw API JSON (Backend or Platform) on stdout                                            |
| `clerk api <path> --include` | Response headers on stderr, body on stdout                                              |
| `clerk config pull`          | Instance config JSON                                                                    |
| `clerk config schema`        | JSON Schema                                                                             |
| `clerk open [subpath]`       | `{url, appId, appName, instanceId, instanceLabel, subpath, opened: false}` (agent mode) |
| `clerk open --print`         | Plain dashboard URL on stdout                                                           |
| Any command (agent mode)     | On error: `{"error":{"code","message","docsUrl?","errors?"}}` on stderr                 |

For commands without an explicit `--json` flag, `clerk api` is your escape hatch: hit the underlying endpoint directly.

## Patterns for agent-driven use

### Diagnose before acting

```sh
clerk doctor --json --spotlight
```

Parse the output, then for each failing check read `remedy` and act. Never call `--fix` from an agent — it's interactive.

In agent mode, `doctor` also includes a **`Host execution`** check when it can
detect that Clerk's host-side state is not writable. If that check warns, stop
trusting auth/link/env/API failures from the same sandboxed run and rerun the
relevant command on the host.

### Preview every mutation

```sh
# Dry run first
clerk api /users/user_abc123 -X DELETE --dry-run
# If the preview is what you expected, run it with --yes
clerk api /users/user_abc123 -X DELETE --yes
```

### Target explicitly

```sh
# Don't rely on the linked profile for critical operations
clerk api /users --app app_abc123 --instance prod
```

The same advice applies to linking in agent mode: `clerk link --app app_abc123` is deterministic and works non-interactively. If you omit `--app`, the command only succeeds when silent autolink can prove the target app from existing publishable keys.

### Use the catalog, not hard-coded paths

```sh
clerk api ls users            # discover available user endpoints
clerk api ls --platform apps   # platform-side endpoints
```

### Surface doctor remedies to the user

When `clerk doctor --json` reports a failure, show the user the `name`, `message`, and `remedy` — don't just silently try to fix it, because the underlying fix (e.g., `clerk auth login`) usually requires human interaction.

`clerk doctor --fix` is disabled in agent mode, so you cannot rely on it. If a caller wants to attempt remediation anyway, map the failing check to the command that would fix it in human mode. Each check exposes this mapping via the optional `fix.label` field on the JSON result:

| Failing check           | Manual remediation                           |
| ----------------------- | -------------------------------------------- |
| `Logged in`             | `clerk auth login`                           |
| `Authentication valid`  | `clerk auth login`                           |
| `CLI configuration`     | `clerk auth login`                           |
| `Project linked`        | `clerk link`                                 |
| `Application reachable` | `clerk link`                                 |
| `Instance IDs`          | `clerk link`                                 |
| `Environment variables` | `clerk env pull`                             |
| `CLI version`           | (no auto-fix; run `clerk update`)            |
| `Shell completion`      | (no auto-fix; see `clerk completion --help`) |

All three remediation commands are themselves interactive by default: `auth login` opens a browser, `link` prompts for an app when `--app` is omitted, and `env pull` writes a file. In agent mode, prefer `clerk link --app <id>` over bare `clerk link`, since the bare form only works when silent autolink can resolve the target app without a picker.

## What NOT to do in agent mode

- **Don't ignore the sandbox warning.** If the CLI says host-only Clerk state or system capabilities may be unavailable, rerun the same command on the host before trusting the result.
- **Don't call `clerk auth login` from an agent and expect it to work** — it opens a browser and waits for a callback. Instead, export `CLERK_PLATFORM_API_KEY`.
- **Don't call `clerk link` without `--app` and assume the agent can pick for you** — it only succeeds when silent autolink can determine the app from detected keys.
- **Don't run `clerk unlink` in agent mode without `--yes`** — it exits with a usage error instead of prompting.
- **Don't run `clerk config put` without `--dry-run` first** — it's a full replacement and is destructive.
- **Don't skip `--yes` on mutations and expect them to work** — agent mode disables prompts, so commands that require confirmation will error.
- **Don't leak secret keys into logs** — the CLI never prints the raw secret key, and you shouldn't either.
