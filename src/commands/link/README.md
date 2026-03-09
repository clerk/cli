# Link Command

Links the current git repository to a Clerk application, storing the app ID
and instance IDs in `~/.clerk/config.json`. The link is keyed by the
normalized git remote URL (e.g., `github.com/org/repo`), so it is
automatically shared across all clones and worktrees of the same repository.

## Usage

```sh
clerk link                    # Interactive app picker
clerk link --app app_abc123   # Link directly by app ID
```

## Options

| Flag         | Description                                       |
| ------------ | ------------------------------------------------- |
| `--app <id>` | Application ID to link (skips interactive picker) |

## Agent Mode

When running in agent mode (`--mode agent` or piped stdin), outputs a structured
prompt describing how to perform the link operation instead of running the
interactive flow.

## Flow

1. Resolves the normalized git remote URL (e.g., `github.com/org/repo`) for cross-clone matching
2. Checks if already linked — if resolved via a remote URL from another clone, prints an auto-link notice
3. Checks for authentication (calls `clerk auth login` if needed)
4. If `--app` is provided, uses that app ID directly
5. Otherwise, fetches the list of applications and presents a searchable picker (type to filter by name)
6. Fetches application details to retrieve instance IDs
7. Stores the profile in `~/.clerk/config.json` keyed by the normalized remote URL
8. Falls back to git-common-dir or the current directory path if no remote is configured

## API Endpoints

| Method | Endpoint                            | Description                                      |
| ------ | ----------------------------------- | ------------------------------------------------ |
| `GET`  | `/v1/platform/applications`         | List all applications for the authenticated user |
| `GET`  | `/v1/platform/applications/{appId}` | Fetch application details with instance IDs      |
