# clerk orgs

Enable or disable Clerk Organizations on the linked instance.

## Usage

```
clerk orgs enable [options]
clerk orgs disable [options]
```

## Options

### `enable`

| Flag                | Description                               |
| ------------------- | ----------------------------------------- |
| `--force-selection` | Force organization selection on login     |
| `--auto-create`     | Auto-create an organization for new users |
| `--max-members <n>` | Maximum members per organization          |
| `--domains`         | Enable verified domains                   |
| `--app <id>`        | Target a specific application             |
| `--instance <id>`   | Target a specific instance (dev, prod)    |
| `--yes`             | Skip confirmation prompts                 |

### `disable`

| Flag              | Description                            |
| ----------------- | -------------------------------------- |
| `--app <id>`      | Target a specific application          |
| `--instance <id>` | Target a specific instance (dev, prod) |
| `--yes`           | Skip confirmation prompts              |

## Clerk API endpoints

| Method | Endpoint                                                          | Description                                                        |
| ------ | ----------------------------------------------------------------- | ------------------------------------------------------------------ |
| GET    | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Fetch current config (used to check billing dependency on disable) |
| PATCH  | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Patch `organization_settings`                                      |
