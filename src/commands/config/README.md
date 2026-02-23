# Config Commands

Manage Clerk instance configuration.

## Commands

### `clerk config pull`

Fetches the instance configuration from the Clerk Platform API and outputs it as JSON.

```sh
clerk config pull
clerk config pull --instance prod
clerk config pull --output clerk-config.json
```

#### Options

| Flag | Description |
|---|---|
| `--instance <id>` | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development. |
| `--output <file>` | Write config to a file instead of stdout |

#### Requirements

- Must have a Clerk project linked to the current directory (via `clerk init`)
- Requires the `CLERK_PLATFORM_API_KEY` environment variable

#### API Endpoints

All requests are made against the Clerk Platform API (default `https://api.clerk.com`, overridable via `CLERK_PLATFORM_API_URL`).

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Fetches the full instance configuration as JSON. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |
