# clerk orgs (enable/disable)

Toggle Clerk Organizations on the linked instance. The handlers are wired to
top-level `clerk enable orgs` and `clerk disable orgs` commands; the source
lives here so future org-related commands (settings, CRUD) can co-locate.

## Usage

```
clerk enable orgs [options]
clerk disable orgs [options]
```

## Options

### `enable`

| Flag                | Description                                |
| ------------------- | ------------------------------------------ |
| `--force-selection` | Force organization selection on login      |
| `--auto-create`     | Auto-create an organization for new users  |
| `--max-members <n>` | Maximum members per organization (integer) |
| `--domains`         | Enable verified domains                    |
| `--app <id>`        | Target a specific application              |
| `--instance <id>`   | Target a specific instance (dev, prod)     |
| `--yes`             | Skip the confirmation prompt               |
| `--dry-run`         | Preview the patch without applying it      |

The boolean flags above are one-way: they set the field to `true` only. To
clear a field, use `clerk config patch --json '{"organization_settings":{...}}'`.

`--auto-create` patches both `organization_creation_defaults.enabled` and
`organization_creation_defaults.automatic_organization_creation.enabled` — the
API only auto-creates organizations when both are true. When this enables
creation defaults for the first time, the API seeds the remaining sub-settings
(name template, fallback name, email-domain detection) with its standard
defaults.

### `disable`

| Flag              | Description                            |
| ----------------- | -------------------------------------- |
| `--app <id>`      | Target a specific application          |
| `--instance <id>` | Target a specific instance (dev, prod) |
| `--yes`           | Skip the confirmation prompt           |
| `--dry-run`       | Preview the patch without applying it  |

When `billing.organization_enabled` is currently true, `disable` warns and asks
for confirmation in human mode. In agent mode (no TTY), the command refuses
unless `--yes` is passed — this avoids stranding org billing in a stale state.
Disabling organizations never disables organization billing automatically; run
`clerk disable billing --for orgs` first if that's what you intend.

## Clerk API endpoints

| Method | Endpoint                                                          | Description                                                               |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------------- |
| GET    | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Fetch current config for diff and the org-billing dependency check        |
| PATCH  | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Patch `organization_settings` (with `?dry_run=true` when `--dry-run` set) |
