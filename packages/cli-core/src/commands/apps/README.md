# `clerk apps`

List all Clerk applications associated with the authenticated account.

## Usage

```
clerk apps [options]
```

### Options

| Option       | Description                                      |
| ------------ | ------------------------------------------------ |
| `--json`     | Output as JSON                                   |
| `--detailed` | Show full instance details including secret keys |

### Examples

```sh
clerk apps                         # List all applications
clerk apps --detailed              # Show instance details with keys
clerk apps --json                  # Output as JSON
clerk apps --json --detailed       # JSON with secret keys included
```

## API Endpoints

| Method | Endpoint                    | Description           |
| ------ | --------------------------- | --------------------- |
| GET    | `/v1/platform/applications` | List all applications |

## Notes

- Requires authentication via `clerk auth login` or `CLERK_PLATFORM_API_KEY` environment variable.
- By default, secret keys are not shown. Use `--detailed` to include them.
- In non-TTY environments (e.g., piped to another command), output defaults to JSON automatically.
