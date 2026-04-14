---
name: clerk-cli
description: Operate the Clerk CLI (`clerk` binary) for authentication, user/org/session management, instance config, env keys, and any Clerk Backend or Platform API call. Use when the user mentions Clerk management tasks, "list clerk users", "create a clerk user", "update organization", "pull clerk config", "clerk env pull", "clerk doctor", "clerk api", or any ad-hoc Clerk API request. Prefer the CLI over raw HTTP: it handles auth, key resolution, app/instance targeting, and formatting automatically.
---

# Clerk CLI

The `clerk` binary is a pre-authenticated gateway to Clerk's Backend API and Platform API, plus project-level tooling (auth, linking, env pulls, instance config). When the user asks anything that touches a Clerk resource, reach for `clerk` first instead of hand-rolling `curl`.

> This skill was installed by `clerk init` and versioned alongside the CLI. If something described here doesn't match the installed binary, run `clerk --version` and `clerk <command> --help`; the binary is the source of truth.

## Prerequisites (verify once per session)

```sh
clerk --version               # confirm the binary is on PATH
clerk doctor --json           # structured health check; exit 1 if anything failed
```

`clerk doctor --json` is the first thing to run when something is off. Each result has `name`, `status` (`pass`/`warn`/`fail`), `message`, and a `remedy` string describing how to fix it. Parse that and act on it, or surface it to the user.

## The mental model

| Layer                           | What it does                                                                                 | Commands                                                       |
| ------------------------------- | -------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| **Session / project**           | Auth, link a repo to a Clerk app, pull env keys                                              | `auth login`, `link`, `unlink`, `whoami`, `env pull`, `doctor` |
| **Instance config**             | Manage the configuration (social providers, session lifetimes, etc.) for a specific instance | `config pull`, `config schema`, `config patch`, `config put`   |
| **Backend API (default)**       | Runtime data: users, orgs, sessions, invitations, JWT templates, webhooks                    | `clerk api <path>`                                             |
| **Platform API (`--platform`)** | Account-level: applications, instances, billing                                              | `clerk api --platform <path>`                                  |

A project is "linked" to an application via `clerk link`. Once linked, most commands auto-resolve the target app and dev instance from the repo's git remote. To target something else, pass `--app <id>` and/or `--instance dev|prod|<instance_id>`. See [references/auth.md](references/auth.md) for the full resolution order.

## Discover endpoints — don't memorize them

The CLI ships with the Clerk OpenAPI catalog. Always discover endpoints dynamically instead of guessing paths:

```sh
clerk api ls                  # list every Backend API endpoint
clerk api ls users            # filter by keyword (matches path, summary, tag, operationId)
clerk api ls --platform apps  # list Platform API endpoints
```

Use this before `clerk api <path>`. If you don't see the endpoint you expected, it probably isn't exposed.

## The `clerk api` command (the workhorse)

`clerk api` makes authenticated HTTP calls. It auto-resolves keys, auto-detects method from body presence, supports stdin, and can preview mutations with `--dry-run`.

```sh
# GET requests
clerk api /users                                  # list users
clerk api /users/user_abc123                      # fetch one
clerk api /users?limit=5&order_by=-created_at     # query params work inline

# Mutating requests
clerk api /users -d '{"email_address":["a@b.co"]}'          # POST (auto-detected from body)
clerk api /users/user_abc123 -X PATCH -d '{"first_name":"A"}'
clerk api /users/user_abc123 -X DELETE

# Body from file or stdin
clerk api /users --file payload.json
cat payload.json | clerk api /users

# Always preview mutations first
clerk api /users/user_abc123 -X DELETE --dry-run
clerk api /users/user_abc123 -X DELETE --yes      # skip confirmation once you've verified

# Target a specific app/instance
clerk api /users --app app_abc123 --instance prod

# Include response headers when debugging
clerk api /users --include

# Platform API (account-level, not tenant data)
clerk api /v1/platform/applications --platform
```

**Always `--dry-run` a mutation before running it for real.** Then re-run without `--dry-run` (add `--yes` if you're sure). In agent mode, interactive confirmation is bypassed, so `--dry-run` is the only safety net for destructive calls.

**JSON bodies must be valid JSON.** The CLI validates and rejects malformed payloads.

**Endpoint paths may be given with or without `/v1/` prefix** — both work for Backend API calls. The CLI normalizes.

See [references/recipes.md](references/recipes.md) for concrete patterns: listing/filtering users, creating orgs, impersonation sessions, etc.

## Core commands at a glance

| Command                 | Purpose                                                                                           | Key flags                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `clerk auth login`      | OAuth browser login (stores token). Agent mode: no-op if already logged in, else prints guidance. | —                                                                                            |
| `clerk auth logout`     | Clear stored credentials.                                                                         | —                                                                                            |
| `clerk whoami`          | Print the logged-in email.                                                                        | —                                                                                            |
| `clerk link`            | Link this repo to a Clerk app.                                                                    | `--app <id>`                                                                                 |
| `clerk unlink`          | Remove the link.                                                                                  | `--yes`                                                                                      |
| `clerk env pull`        | Write publishable + secret keys to `.env.local` (merge, not clobber).                             | `--app`, `--instance`, `--file`                                                              |
| `clerk config pull`     | Fetch instance config JSON.                                                                       | `--app`, `--instance`, `--output`, `--keys`                                                  |
| `clerk config schema`   | Fetch the JSON Schema for the instance config.                                                    | `--app`, `--instance`, `--output`, `--keys`                                                  |
| `clerk config patch`    | Partial update (PATCH) of instance config.                                                        | `--file`, `--json`, `--dry-run`, `--yes`                                                     |
| `clerk config put`      | Full replacement (PUT) of instance config — **destructive**.                                      | `--file`, `--json`, `--dry-run`, `--yes`                                                     |
| `clerk apps list`       | List Clerk applications.                                                                          | `--json`                                                                                     |
| `clerk doctor`          | Health check.                                                                                     | `--json`, `--spotlight`, `--verbose`, `--fix`                                                |
| `clerk api [path]`      | Authenticated HTTP to Backend/Platform API.                                                       | `-X`, `-d`, `--file`, `--dry-run`, `--yes`, `--include`, `--app`, `--instance`, `--platform` |
| `clerk api ls [filter]` | Discover endpoints from the bundled OpenAPI catalog.                                              | `--platform`                                                                                 |

Run `clerk <command> --help` for the authoritative, up-to-date flag list.

## Agent-mode behavior (important)

The CLI auto-detects agent mode when stdout is not a TTY, or when `--mode agent` / `CLERK_MODE=agent` is set. In agent mode:

- **Interactive prompts are disabled.** Commands that would normally show pickers (`link` without `--app`, interactive `api`, `unlink` without `--yes`) either auto-resolve, print structured guidance, or exit. Always pass explicit flags (`--app`, `--yes`) in scripted calls.
- **Mutations still require `--yes`** unless you accept per-call confirmation is impossible.
- **`doctor --fix` is ignored.** Parse `doctor --json` output's `remedy` field and act on it yourself.
- **`apps list` defaults to JSON** when piped.
- **`clerk init --prompt`** prints a short agent-oriented handoff telling the agent to run `clerk init -y` (it is NOT a framework-specific integration guide — use the runtime `clerk init` output itself for that).

Full matrix in [references/agent-mode.md](references/agent-mode.md).

## Output format and errors

- **JSON output:** `--json` on `apps list` and `doctor`. For `clerk api`, the response body is the raw API JSON, so pipe into `jq` freely.
- **Exit codes:** `0` success, `1` runtime error, `2` usage/validation error. `doctor` returns `1` if any check failed.
- **Error format:** User-facing errors print a single line to stderr and set a non-zero exit code. Use `--verbose` for stack traces when debugging.

## Safety rules for autonomous use

1. **Discover before acting:** `clerk api ls <keyword>` before `clerk api <path>`.
2. **Preview mutations:** `--dry-run` on every `config patch`, `config put`, `api -X POST/PATCH/PUT/DELETE`.
3. **Target explicitly in production:** pass `--instance prod` rather than relying on defaults, and confirm with the user before any production mutation.
4. **Never commit secrets:** `env pull` writes to `.env.local` (which should be gitignored). Don't paste secret keys into code or chat.
5. **Use `doctor --json`** to diagnose before assuming the CLI is broken.

## References

- [references/auth.md](references/auth.md) — auth flow, key resolution order, `--app`/`--instance` targeting, Backend vs Platform API.
- [references/recipes.md](references/recipes.md) — copy-pasteable recipes for common Clerk tasks.
- [references/agent-mode.md](references/agent-mode.md) — agent-mode behavior matrix, exit codes, error format.
