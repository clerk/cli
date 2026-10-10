# API Command

Make authenticated HTTP requests to Clerk APIs directly from the command line.

By default, targets the Clerk Backend API (`https://api.clerk.dev/v1/`) using
the instance secret key. Use `--platform` to target the Platform API instead.

Works with no login and no linked project on an **unclaimed accountless
application** — the one an SDK creates for itself the first time you run
`next dev` (or similar) with no keys configured — by reading the secret key it
already left on disk. See [Authentication](#authentication) below.

## Usage

```sh
# List available API endpoints
clerk api ls

# Filter endpoints by keyword
clerk api ls users

# Interactive request builder (TTY only)
clerk api

# List users
clerk api /users

# Get a specific user
clerk api /users/user_abc123

# Create a user (method auto-detected as POST from body)
clerk api /users -d '{"email_address":["alice@example.com"]}'

# Update with explicit method
clerk api /users/user_abc123 -X PATCH -d '{"first_name":"Alice"}'

# Delete a user
clerk api /users/user_abc123 -X DELETE

# Read body from file
clerk api /users --file create-user.json

# Pipe body from stdin
cat payload.json | clerk api /users

# Show response headers
clerk api /users --include

# Preview without executing
clerk api /users -X DELETE --dry-run

# Use a specific secret key
clerk api /users --secret-key sk_test_abc123

# Resolve a secret key from an app directly
clerk api /users --app app_123 --instance prod

# Target production instance (requires a Platform API token, see Authentication)
clerk api /users --instance prod

# Platform API mode
clerk api /v1/platform/applications --platform

# Frontend API mode — fetch the public environment payload to verify config
clerk api --fapi /environment --app app_123 --instance dev
```

## Request bodies and shell quoting

`-d` takes the body exactly as your shell hands it over, and the CLI parses it
before sending — an unparseable payload fails locally with the reason, instead of
costing a round trip and a server-side byte offset. When the value reached the
CLI with its double quotes stripped, or wrapped in literal single quotes, the
error names the shell quoting behind it.

The `-d '{"key":"value"}'` form in the examples above is POSIX shell syntax: the
single quotes keep bash and zsh from consuming the double quotes inside. Leave
them off and the shell strips those quotes, so the CLI receives `{key:value}`.

Even with the single quotes, that form fails in PowerShell before 7.3 and in
cmd.exe:

- **PowerShell before 7.3** passes an argument's embedded double quotes to a
  native program unescaped, so the program's command-line parser consumes them:
  `-d '{"user_id":"x"}'` arrives as `{user_id:x}`. PowerShell 7.3 fixed this.
- **cmd.exe** gives `'` no special meaning, so the wrapping single quotes are
  passed through as part of the value, and the double quotes inside are consumed
  the same way: `'{user_id:x}'`.

`--file` and piped stdin sidestep the shell entirely and behave the same
everywhere, so prefer them for anything non-trivial and in scripts:

```sh
clerk api /users --file body.json
cat body.json | clerk api /users
```

## Options

| Flag                    | Description                                                                     |
| ----------------------- | ------------------------------------------------------------------------------- |
| `-X, --method <method>` | HTTP method. Defaults to GET, or POST if body is provided.                      |
| `-d, --data <json>`     | JSON request body (inline)                                                      |
| `--file <path>`         | Read request body from a file                                                   |
| `--include`             | Show response status and headers                                                |
| `--app <id>`            | Application ID to target when resolving keys                                    |
| `--secret-key <key>`    | Override the secret key                                                         |
| `--instance <id>`       | Instance to target for key resolution (`dev`, `prod`, or full ID)               |
| `--platform`            | Use Platform API instead of Backend API                                         |
| `--fapi`                | Use the instance's public Frontend API (no auth; host from the publishable key) |
| `--dry-run`             | Show request without executing                                                  |
| `--yes`                 | Skip confirmation for mutating requests                                         |

## Authentication

Secret key resolution order (Backend API, the default):

1. `--secret-key` flag (explicit)
2. Auto-resolve from `--app <id>` via the Platform API (see below)
3. This project's own accountless secret key — from `CLERK_SECRET_KEY`, `.env.local`
   (or the framework's detected env var name), or the SDK's own `.clerk/.tmp/keyless.json`
4. Auto-resolve from linked project profile via the Platform API (see below)

Step 2 exchanges a Platform API token for the target instance's secret key and
works from any directory (no `clerk link` required). Step 3 is what makes
`clerk api` work out of the box against an **unclaimed accountless application** —
the one an SDK creates for itself on first `next dev` (or similar) with no keys
configured — with no login and no Platform API auth at all; it only applies when
the directory isn't linked and `--app` wasn't passed, since either of those names
an explicit destination the on-disk key might not belong to. Step 4 uses the app
ID stored by `clerk link` and needs Platform API auth like step 2.

Platform API auth (used by `--platform` mode, and by steps 3 and 4 above):

1. `CLERK_PLATFORM_API_KEY` environment variable (`ak_...`)
2. Stored `clerk auth login` token
3. Interactive human-mode prompt for a Platform API key

The CLI validates key prefixes and will warn if you pass an `ak_` key where an `sk_` key is expected, or vice versa.

### Frontend API (`--fapi`)

`--fapi` targets the instance's public Frontend API — the same surface clerk-js
consumes — which is useful for verifying that a config change took effect (e.g.
`clerk api --fapi /environment`). The FAPI host is resolved from the instance's
publishable key, looked up via the Platform API from `--app`/`--instance` or the
linked project, so resolving the host needs Platform API auth, but the request
itself is unauthenticated (these endpoints are public). `--fapi` and `--platform`
cannot be combined. Paths are `/v1`-normalized like the other modes, so both
`/environment` and `/v1/environment` work.

## API Endpoints

### Backend API (default)

Base URL: `https://api.clerk.dev` (overridable via `CLERK_BACKEND_API_URL`)

| Method | Endpoint     | Description                                                                          |
| ------ | ------------ | ------------------------------------------------------------------------------------ |
| Any    | `/v1/{path}` | Pass-through to Clerk Backend API. Authenticated via `Bearer` token from secret key. |

### Platform API (`--platform`)

Base URL: `https://api.clerk.com` (overridable via `CLERK_PLATFORM_API_URL`)

| Method | Endpoint     | Description                                                                                                                        |
| ------ | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| Any    | `/v1/{path}` | Pass-through to Clerk Platform API. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`, `clerk auth login`, or prompt. |

## Subcommands

### `clerk api ls [filter]`

Lists available API endpoints from the Clerk OpenAPI spec.

- Fetches the spec from `clerk/openapi-specs` on GitHub
- Caches locally in `~/.clerk/cache/` for 1 hour
- Supports `--platform` to list Platform API endpoints
- Optional filter keyword matches against path, summary, tag, and operation ID

### `clerk api` (interactive mode)

When run with no arguments in a TTY, launches an interactive request builder:

1. Select an API category (Users, Organizations, Sessions, etc.)
2. Select an endpoint
3. Fill in path parameters (if any)
4. Optionally provide a request body (opens `$EDITOR`)
5. Preview and confirm before executing

Requires human mode (TTY). In agent mode, prints usage help instead.

## Safety

- POST, PUT, PATCH, and DELETE requests prompt for confirmation in interactive mode
- Use `--yes` to skip confirmation (for scripting)
- Use `--dry-run` to preview without executing
