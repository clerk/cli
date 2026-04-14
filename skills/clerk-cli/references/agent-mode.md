# Clerk CLI — Agent Mode Reference

The Clerk CLI has a first-class "agent" mode that's designed for non-interactive and AI-driven use. Read this before writing scripts or letting an LLM drive the CLI.

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
| Confirmation prompts (`unlink`, `config patch`, `api -X DELETE`) | Prompt y/n                     | Require `--yes`, otherwise error                                                                                                                                      |
| `clerk doctor --fix`                                             | Interactively offers fixes     | **Ignored**; output the `remedy` field and let the caller act                                                                                                         |
| `clerk apps list` default output                                 | Table                          | JSON (when piped)                                                                                                                                                     |
| `clerk auth login` when already authenticated                    | Prompt to re-auth              | Silent no-op                                                                                                                                                          |
| `clerk init`                                                     | Full interactive scaffold flow | Skips the interactive scaffold and either runs non-interactively with `--yes` or, with `--prompt`, emits a short agent handoff pointing the agent at `clerk init -y`. |
| Color / spinners                                                 | Enabled                        | Disabled                                                                                                                                                              |

**Rule of thumb:** always pass `--yes` for mutations, `--json` for structured output where available, and `--app` / `--instance` explicitly instead of relying on pickers.

## Exit codes

| Code | Meaning                                                                      |
| ---- | ---------------------------------------------------------------------------- |
| `0`  | Success                                                                      |
| `1`  | Runtime error (auth failure, API error, file I/O, etc.)                      |
| `2`  | Usage or validation error (bad flags, malformed JSON body, unknown endpoint) |

`clerk doctor` exits `1` when any check fails (warnings alone still exit `0`).

## Error output format

- Single-line error message on stderr.
- Stack traces hidden unless `--verbose` is passed.
- API errors include the first message from the response body, prefixed with a human context string (e.g., `Failed to fetch config: unauthorized`).
- User-aborted commands exit cleanly with no error output.

When handling errors programmatically, read stderr, check the exit code, and re-run with `--verbose` to get a trace if you need to debug.

## Structured outputs you can rely on

| Command                      | Structured output                                   |
| ---------------------------- | --------------------------------------------------- |
| `clerk doctor --json`        | `[{name, status, message, detail?, remedy?, fix?}]` |
| `clerk apps list --json`     | Array of application objects                        |
| `clerk api <path>`           | Raw API JSON (Backend or Platform) on stdout        |
| `clerk api <path> --include` | Response headers on stderr, body on stdout          |
| `clerk config pull`          | Instance config JSON                                |
| `clerk config schema`        | JSON Schema                                         |

For commands without an explicit `--json` flag, `clerk api` is your escape hatch: hit the underlying endpoint directly.

## Patterns for agent-driven use

### Diagnose before acting

```sh
clerk doctor --json --spotlight
```

Parse the output, then for each failing check read `remedy` and act. Never call `--fix` from an agent — it's interactive.

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

### Use the catalog, not hard-coded paths

```sh
clerk api ls users            # discover available user endpoints
clerk api ls -- --platform apps   # platform-side endpoints
```

### Surface doctor remedies to the user

When `clerk doctor --json` reports a failure, show the user the `name`, `message`, and `remedy` — don't just silently try to fix it, because the underlying fix (e.g., `clerk auth login`) usually requires human interaction.

## What NOT to do in agent mode

- **Don't call `clerk auth login` from an agent and expect it to work** — it opens a browser and waits for a callback. Instead, export `CLERK_PLATFORM_API_KEY`.
- **Don't call interactive `clerk link` without `--app`** — it will print guidance, not pick an app.
- **Don't run `clerk config put` without `--dry-run` first** — it's a full replacement and is destructive.
- **Don't skip `--yes` on mutations and expect them to work** — agent mode disables prompts, so commands that require confirmation will error.
- **Don't leak secret keys into logs** — the CLI never prints the raw secret key, and you shouldn't either.
