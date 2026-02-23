# API Command

Make authenticated HTTP requests to Clerk APIs directly from the command line.

By default, targets the Clerk Backend API (`https://api.clerk.dev/v1/`) using
the instance secret key. Use `--platform` to target the Platform API instead.

## Usage

```sh
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

# Target production instance (requires CLERK_PLATFORM_API_KEY)
clerk api /users --instance prod

# Platform API mode
clerk api /v1/platform/applications --platform
```

## Options

| Flag | Description |
|---|---|
| `-X, --method <method>` | HTTP method. Defaults to GET, or POST if body is provided. |
| `-d, --data <json>` | JSON request body (inline) |
| `--file <path>` | Read request body from a file |
| `--include` | Show response status and headers |
| `--secret-key <key>` | Override the secret key |
| `--instance <id>` | Instance to target for key resolution (`dev`, `prod`, or full ID) |
| `--platform` | Use Platform API instead of Backend API |
| `--dry-run` | Show request without executing |
| `--yes` | Skip confirmation for mutating requests |

## Authentication

Secret key resolution order:

1. `--secret-key` flag (explicit)
2. `CLERK_SECRET_KEY` environment variable
3. Auto-resolve from linked project profile (requires `CLERK_PLATFORM_API_KEY`)

For `--platform` mode, uses `CLERK_PLATFORM_API_KEY` environment variable.

## API Endpoints

### Backend API (default)

Base URL: `https://api.clerk.dev` (overridable via `CLERK_BACKEND_API_URL`)

| Method | Endpoint | Description |
|---|---|---|
| Any | `/v1/{path}` | Pass-through to Clerk Backend API. Authenticated via `Bearer` token from secret key. |

### Platform API (`--platform`)

Base URL: `https://api.clerk.com` (overridable via `CLERK_PLATFORM_API_URL`)

| Method | Endpoint | Description |
|---|---|---|
| Any | `/v1/{path}` | Pass-through to Clerk Platform API. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |

## Safety

- POST, PUT, PATCH, and DELETE requests prompt for confirmation in interactive mode
- Use `--yes` to skip confirmation (for scripting)
- Use `--dry-run` to preview without executing
