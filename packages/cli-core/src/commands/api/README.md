# API Command

Make authenticated HTTP requests to Clerk APIs directly from the command line.

By default, targets the Clerk Backend API (`https://api.clerk.dev/v1/`) using
the instance secret key. Use `--platform` to target the Platform API instead.

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
2. `CLERK_SECRET_KEY` environment variable
3. Auto-resolve from `--app <id>` via the Platform API (see below)
4. Auto-resolve from linked project profile via the Platform API (see below)

Steps 3 and 4 both exchange a Platform API token for the target instance's
secret key, so either needs Platform API auth to be available. Step 3 works
from any directory (no `clerk link` required); step 4 uses the app ID stored
by `clerk link`.

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
