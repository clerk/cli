# clerk billing

Enable/disable billing and manage subscription plans on the linked instance.

## Usage

```
clerk billing enable --for <org|user> [options]
clerk billing disable --for <org|user> [options]
clerk billing plans create <slug> [options]
clerk billing plans list [options]
clerk billing plans update <slug> [options]
clerk billing plans remove <slug> [options]
```

## Options

### `enable` / `disable`

| Flag                       | Description                                          |
| -------------------------- | ---------------------------------------------------- |
| `--for <org\|user>`        | **(required)** Target billing type                   |
| `--require-payment-method` | Require payment method for free trials (enable only) |
| `--app <id>`               | Target a specific application                        |
| `--instance <id>`          | Target a specific instance (dev, prod)               |

### `plans create`

| Flag                      | Description                                                         |
| ------------------------- | ------------------------------------------------------------------- |
| `<slug>`                  | Plan slug (positional). Display name is auto-derived via title case |
| `--name <name>`           | Override display name (default: title-cased slug)                   |
| `--amount <cents>`        | **(required)** Monthly price in cents                               |
| `--payer <org\|user>`     | **(required)** Who pays                                             |
| `--currency <code>`       | Currency code (default: usd)                                        |
| `--description <text>`    | Plan description                                                    |
| `--trial-days <n>`        | Free trial length in days                                           |
| `--annual-amount <cents>` | Monthly equivalent when billed annually, in cents                   |
| `--hidden`                | Hide plan from end users                                            |
| `--app <id>`              | Target a specific application                                       |
| `--instance <id>`         | Target a specific instance (dev, prod)                              |

### `plans list`

| Flag              | Description                            |
| ----------------- | -------------------------------------- |
| `--json`          | Output as JSON                         |
| `--app <id>`      | Target a specific application          |
| `--instance <id>` | Target a specific instance (dev, prod) |

### `plans update`

| Flag                      | Description                            |
| ------------------------- | -------------------------------------- |
| `<slug>`                  | Plan slug to update (positional)       |
| `--name <name>`           | Update display name                    |
| `--amount <cents>`        | Update monthly price                   |
| `--currency <code>`       | Update currency                        |
| `--description <text>`    | Update description                     |
| `--trial-days <n>`        | Update free trial days                 |
| `--annual-amount <cents>` | Update annual amount                   |
| `--hidden`                | Hide plan                              |
| `--visible`               | Show plan                              |
| `--app <id>`              | Target a specific application          |
| `--instance <id>`         | Target a specific instance (dev, prod) |

### `plans remove`

| Flag              | Description                            |
| ----------------- | -------------------------------------- |
| `<slug>`          | Plan slug to remove (positional)       |
| `--app <id>`      | Target a specific application          |
| `--instance <id>` | Target a specific instance (dev, prod) |

## Clerk API endpoints

| Method | Endpoint                                                          | Description                                  |
| ------ | ----------------------------------------------------------------- | -------------------------------------------- |
| GET    | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Fetch current config (for plans list/remove) |
| PATCH  | `/v1/platform/applications/{appId}/instances/{instanceId}/config` | Patch billing and plans config               |
