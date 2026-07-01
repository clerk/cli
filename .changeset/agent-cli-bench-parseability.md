---
"clerk": minor
---

Improve agent-CLI parseability, discoverability, and recoverability per agentcli-bench rubric.

- **Global flags**: `--quiet` silences non-essential output (mirrors existing `--verbose`); `--no-color` disables ANSI sequences (complements `NO_COLOR` env). Both appear in `clerk --help`.
- **Exit codes** now align with BSD sysexits so agents can branch on the code alone: `EX_USAGE=64` (bad flag/subcommand/missing arg), `EX_NOPERM=77` (auth), `EX_TEMPFAIL=75` and `EX_UNAVAILABLE=69` (transient/upstream), `EX_DATAERR=65`, `EX_SOFTWARE=70`. Commander's `unknownOption` / `unknownCommand` / `missingArgument` errors now exit `64` instead of `1`.
- **Structured JSON errors** now include `retryable: boolean`, `nextStep: string`, and `docsUrl?: string`. 5xx and network failures (ECONNREFUSED/RESET/ETIMEDOUT/EAI_AGAIN/'fetch failed') are flagged retryable so agents can implement a single retry loop. The bad-flag JSON envelope points at `clerk --help`.
- **`clerk schema`**: new top-level subcommand that emits the full command tree (`{cli, version, schemaVersion, command}`) as JSON. Agents can walk every subcommand, argument, and option (with choices and defaults) without parsing `--help` text.
- **`clerk whoami --json`**: returns `{authenticated, user, linked, app, appName}`. Unauthenticated state is a value (`authenticated:false`), not a thrown error.
- **`clerk users list --json`** now includes `nextCursor` (offset-encoded) and a `pagination` envelope alongside the existing `data` and `hasMore` fields.
- **`clerk apps create --if-not-exists`**: idempotent flag that looks up an existing app by name and returns it (with `reused:true` in JSON) instead of creating a duplicate.
- **Top-level `--help`** gains a `Next:` block (`auth login`, `init`, `doctor`) and a `Documentation:` block linking to https://clerk.com/docs/cli and https://github.com/clerk/cli.
