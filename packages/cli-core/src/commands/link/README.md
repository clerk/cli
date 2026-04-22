# Link Command

Links the current git repository to a Clerk application, storing the app ID
and instance IDs in the config file. The link is keyed by the
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

In agent mode (`--mode agent` or piped stdout), `clerk link` only runs through
deterministic paths:

- `clerk link --app app_abc123` links directly
- bare `clerk link` first tries silent autolink from detected publishable keys
- if no unambiguous app can be determined, the command exits with a usage error
  telling the caller to pass `--app`

## Flow

1. Resolves the normalized git remote URL (e.g., `github.com/org/repo`) for cross-clone matching
2. Checks if already linked — if resolved via a remote URL from another clone, prints an auto-link notice
   - With `skipIfLinked` (used by `clerk init`), returns immediately
   - Otherwise, offers to upgrade the profile key to use the git remote if available, or asks to re-link
3. If `skipIfLinked` and not already linked, tries silent autolink (detect keys → match → persist without prompting)
4. Checks for authentication (calls `clerk auth login` if needed)
5. If `--app` is provided, fetches that app directly
6. Otherwise, fetches the list of applications and scans for publishable keys in env vars / `.env` / `.env.local`
7. If a key matches an application, suggests it: "We found \<app\>. Link to this application?"
   - If the user confirms (default), links to the detected app
   - If the user declines, falls through to the interactive picker
8. If no match (or no apps exist), presents a searchable picker (type to filter by name)
   - The picker always includes a "+ Create a new application" option pinned at the bottom
   - Selecting it prompts for a name and creates the app via the Platform API
   - For non-interactive/CI/agent flows, create apps from the Clerk Dashboard or via the Platform API, then pass `--app <id>`
9. Stores the profile in the config file keyed by the normalized remote URL
10. Falls back to git-common-dir or the current directory path if no remote is configured

## Key Detection

When running `clerk link` without `--app`, the command scans for publishable keys
and suggests the matching application before showing the interactive picker.
This is implemented in `src/lib/autolink.ts`.

Framework detection (`src/lib/framework.ts`) reads `package.json` to determine
the correct publishable key env var name (e.g., `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
for Next.js, `CLERK_PUBLISHABLE_KEY` as fallback).

### Detection order

1. **Environment variables** (highest priority):
   The framework-specific publishable key env var
   (`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY`, etc.)
   or `CLERK_PUBLISHABLE_KEY` as fallback
2. **`.env.local`** file in the project directory
3. **`.env`** file in the project directory

### Matching

Detected publishable keys are matched against all applications returned by
`GET /v1/platform/applications`. A lookup map is built from each instance's
`publishable_key` field, and the first detected key that matches wins.

## API Endpoints

| Method | Endpoint                            | Description                                      |
| ------ | ----------------------------------- | ------------------------------------------------ |
| `GET`  | `/v1/platform/applications`         | List all applications for the authenticated user |
| `GET`  | `/v1/platform/applications/{appId}` | Fetch application details with instance IDs      |
| `POST` | `/v1/platform/applications`         | Create a new application (interactive picker)    |
