# clerk billing (enable/disable)

Toggle Clerk billing for organizations and/or users on the linked instance.
The handlers are wired to top-level `clerk enable billing` and `clerk disable
billing` commands.

For arbitrary billing config edits (plans, trials, payment-method requirements)
use `clerk config patch --json '{"billing":{...}}'` until a dedicated
`clerk billing settings` command lands.

## Usage

```
clerk enable billing [--for <targets>] [options]
clerk disable billing [--for <targets>] [options]
```

`<targets>` is `org` and/or `user`, accepted as space-separated, comma-separated,
or repeated `--for` flags (matching `clerk config pull --keys`). When omitted,
the command targets both:

```sh
clerk enable billing --for org user
clerk enable billing --for org,user
clerk enable billing --for org --for user
clerk enable billing                   # defaults to both
```

## Options

| Flag              | Description                                                                     |
| ----------------- | ------------------------------------------------------------------------------- |
| `--for <targets>` | Targets (`org` and/or `user`), separated by spaces or commas. Defaults to both. |
| `--app <id>`      | Target a specific application                                                   |
| `--instance <id>` | Target a specific instance (dev, prod)                                          |
| `--yes`           | Skip the confirmation prompt                                                    |
| `--dry-run`       | Preview the patch without applying it                                           |

## Cascade behavior

- `enable billing --for org` (or `org,user`, or no `--for`) **also** sets
  `organization_settings.enabled = true`. Billing for organizations requires
  organizations enabled, so this saves a separate command. The cascade is
  idempotent — if organizations are already on, the diff is empty for that
  field.
- `disable billing` **never** touches `organization_settings`. To disable
  organizations themselves, run `clerk disable orgs` separately.

## Clerk API endpoints

| Method | Endpoint                                                          | Description                                                   |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------- |
| GET    | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Fetch current config for diff before mutation                 |
| PATCH  | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Patch `billing.*` (with `?dry_run=true` when `--dry-run` set) |
