# `clerk apps`

Manage your Clerk applications.

## Subcommands

### `clerk apps list`

List all Clerk applications associated with the authenticated account.

#### Usage

```
clerk apps list [options]
```

#### Options

| Option   | Description    |
| -------- | -------------- |
| `--json` | Output as JSON |

#### Examples

```sh
clerk apps list                    # List all applications
clerk apps list --json             # Output as JSON
```

### `clerk apps create`

Create a new Clerk application.

#### Usage

```
clerk apps create <name> [options]
```

#### Options

| Option   | Description    |
| -------- | -------------- |
| `--json` | Output as JSON |

#### Examples

```sh
clerk apps create "My App"             # Create a new application
clerk apps create "My App" --json      # Output as JSON
```

## API Endpoints

| Method | Endpoint                             | Description              |
| ------ | ------------------------------------ | ------------------------ |
| GET    | `/v1/platform/applications`          | List all applications    |
| POST   | `/v1/platform/applications`          | Create a new application |
| GET    | `/v1/platform/applications/{app_id}` | Fetch application detail |

## Notes

- Requires authentication via `clerk auth login` or `CLERK_PLATFORM_API_KEY` environment variable.
- Secret keys are never shown in output.
- In non-TTY environments (e.g., piped to another command), output defaults to JSON automatically.
