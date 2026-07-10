# clerk orgs (enable/disable)

Toggle Clerk Organizations on the linked instance. The handlers are wired to
top-level `clerk enable orgs` and `clerk disable orgs` commands; the source
lives here so future org-related commands (settings, CRUD) can co-locate.

In human mode, the command frame title echoes the resolved target instance as a dim `· on <instance>` suffix (for example `· on feature-auth` when the active pointer targets a branch), so it is always visible which instance the command acts on.

## Usage

```
clerk enable orgs [options]
clerk disable orgs [options]
```

## Options

### `enable`

| Flag                | Description                                                                         |
| ------------------- | ----------------------------------------------------------------------------------- |
| `--force-selection` | Force organization selection on login                                               |
| `--auto-create`     | Auto-create an organization for new users                                           |
| `--max-members <n>` | Maximum members per organization (integer)                                          |
| `--domains`         | Enable verified domains                                                             |
| `--app <id>`        | Target a specific application                                                       |
| `--instance <id>`   | Target a specific instance (dev, prod)                                              |
| `--branch <name>`   | Target a branch by name (e.g. `agent/pr-42`). Mutually exclusive with `--instance`. |
| `--yes`             | Skip the confirmation prompt                                                        |
| `--dry-run`         | Preview the patch without applying it                                               |

The boolean flags above are one-way: they set the field to `true` only. To
clear a field, use `clerk config patch --json '{"organization_settings":{...}}'`.

### `disable`

| Flag              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--app <id>`      | Target a specific application                                                       |
| `--instance <id>` | Target a specific instance (dev, prod)                                              |
| `--branch <name>` | Target a branch by name (e.g. `agent/pr-42`). Mutually exclusive with `--instance`. |
| `--yes`           | Skip the confirmation prompt                                                        |
| `--dry-run`       | Preview the patch without applying it                                               |

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
