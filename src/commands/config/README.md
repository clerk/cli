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

---

### `clerk config patch`

Partially updates instance configuration using a PATCH request. Only the fields you include in the payload are modified; everything else remains unchanged.

Input can be provided via `--json` (inline), `--file` (path to a JSON file), or piped to stdin. When running interactively, the command shows the payload and prompts for confirmation before sending.

```sh
clerk config patch --json '{"session":{"lifetime":3600}}'
clerk config patch --file partial-config.json
cat partial-config.json | clerk config patch
clerk config patch --file partial-config.json --dry-run
```

#### Options

| Flag | Description |
|---|---|
| `--instance <id>` | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development. |
| `--file <path>` | Read config JSON from a file |
| `--json <string>` | Pass config JSON inline (takes priority over `--file`) |
| `--dry-run` | Show what would be sent without making the API call |
| `--yes` | Skip confirmation prompts |

#### Requirements

- Must have a Clerk project linked to the current directory (via `clerk init`)
- Requires the `CLERK_PLATFORM_API_KEY` environment variable

#### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `PATCH` | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Partially updates instance configuration. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |

---

### `clerk config put`

Replaces the entire instance configuration using a PUT request. The payload you send becomes the complete configuration, overwriting all existing values.

Input can be provided via `--json` (inline), `--file` (path to a JSON file), or piped to stdin. When running interactively, the command shows a destructive-action warning and prompts for confirmation before sending.

```sh
clerk config put --file full-config.json
clerk config put --json '{"session":{"lifetime":3600},"sign_in":{"enabled":true}}'
cat full-config.json | clerk config put
clerk config put --file full-config.json --dry-run
```

#### Options

| Flag | Description |
|---|---|
| `--instance <id>` | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development. |
| `--file <path>` | Read config JSON from a file |
| `--json <string>` | Pass config JSON inline (takes priority over `--file`) |
| `--dry-run` | Show what would be sent without making the API call |
| `--yes` | Skip confirmation prompts |

#### Requirements

- Must have a Clerk project linked to the current directory (via `clerk init`)
- Requires the `CLERK_PLATFORM_API_KEY` environment variable

#### API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `PUT` | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Replaces the full instance configuration. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |
