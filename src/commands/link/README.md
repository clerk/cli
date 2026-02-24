# Link Command

Links the current project directory to a Clerk application, storing the app ID
and instance IDs in `~/.clerk/config.json`.

## Usage

```sh
clerk link                    # Interactive app picker
clerk link --app app_abc123   # Link directly by app ID
```

## Options

| Flag | Description |
|---|---|
| `--app <id>` | Application ID to link (skips interactive picker) |

## Agent Mode

When running in agent mode (`--mode agent` or piped stdin), outputs a structured
prompt describing how to perform the link operation instead of running the
interactive flow.

## Flow

1. Checks for authentication (calls `clerk auth login` if needed)
2. If `--app` is provided, uses that app ID directly
3. Otherwise, fetches the list of applications and presents an interactive picker
4. Fetches application details to retrieve instance IDs
5. Stores the profile in `~/.clerk/config.json` keyed by the current directory

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/v1/platform/applications` | List all applications for the authenticated user |
| `GET` | `/v1/platform/applications/{appId}` | Fetch application details with instance IDs |
