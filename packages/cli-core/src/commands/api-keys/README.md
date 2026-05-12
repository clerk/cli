# clerk api-keys (enable/disable)

Toggle Clerk API Keys on the linked instance. The handlers are wired to
top-level `clerk enable api-keys` and `clerk disable api-keys` commands.

For arbitrary API Keys settings edits, use
`clerk config patch --json '{"api_keys_settings":{...}}'`.

## Usage

```sh
clerk enable api-keys [--for <targets>] [options]
clerk disable api-keys [--for <targets>] [options]
```

`<targets>` is `orgs` and/or `users`, accepted as space-separated,
comma-separated, or repeated `--for` flags. The singular aliases `org` and
`user` are also accepted for backwards compatibility.

```sh
clerk enable api-keys                  # defaults to users
clerk enable api-keys --for orgs users
clerk enable api-keys --for orgs,users
clerk disable api-keys                 # disables API Keys entirely
clerk disable api-keys --for orgs      # disables only organization API Keys
```

## Options

| Flag              | Description                                                                                                                                   |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `--for <targets>` | Targets (`orgs` and/or `users`), separated by spaces or commas. Enable defaults to users; disable without `--for` disables API Keys entirely. |
| `--app <id>`      | Target a specific application                                                                                                                 |
| `--instance <id>` | Target a specific instance (dev, prod)                                                                                                        |
| `--yes`           | Skip the confirmation prompt                                                                                                                  |
| `--dry-run`       | Preview the patch without applying it                                                                                                         |

## Cascade behavior

- `enable api-keys --for orgs` also sets `organization_settings.enabled = true`.
  Organization API Keys require organizations enabled, so this saves a separate
  command. The cascade is idempotent.
- `disable api-keys --for orgs` disables only organization API Keys and leaves
  organizations enabled.
- `disable api-keys` without `--for` disables API Keys entirely.

## Clerk API endpoints

| Method | Endpoint                                                          | Description                                                             |
| ------ | ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| GET    | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Fetch current config for diff before mutation                           |
| PATCH  | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Patch `api_keys_settings.*` (with `?dry_run=true` when `--dry-run` set) |
