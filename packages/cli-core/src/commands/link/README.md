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
- bare `clerk link` in a folder a signed-out `clerk init` set up first claims that application (see [Claiming the `clerk init` application](#claiming-the-clerk-init-application))
- bare `clerk link` then tries silent autolink from detected publishable keys
- if no unambiguous app can be determined, the command exits with a usage error
  telling the caller to pass `--app`

`clerk init` calls `link` with an internal `createIfMissing` option (the
project name) so an authenticated agent run that finds no autolink match auto-
creates a fresh app named after the project instead of erroring. The CLI does
not expose `createIfMissing` as a flag — it is library-only and reserved for
`clerk init`'s flow.

## Claiming the `clerk init` application

A signed-out `clerk init` creates an application that no account owns and
saves its claim token in `.clerk/keyless.json`. The picker can't list that
application, so bare `clerk link` claims it first, when the folder has no link
and no `--app` is given:

1. Signs in if needed, without letting sign-in claim the application itself
2. Claims the application into your account with the token, which deletes `.clerk/keyless.json`
3. Compares the publishable keys in the env var, `.env`, and `.env.local` with the claimed application's development key
4. If they all match (or there are none), links the folder, writes the application's keys to the env file, prints "Claimed and linked application: ..." and the application's Dashboard URL, and stops
5. If any key belongs to a different application, links nothing, leaves the env files unchanged, and exits 1 with `key_pair_mismatch`. The message names the claimed application and the file, and tells you to run `clerk link --app <app_id>` with the application the folder should use
6. If an env file can't be read, links the folder but writes no keys, and warns with the file and the reason. Run `clerk env pull` once the file is fixed
7. If the claim succeeds but saving the link fails, prints "Claimed application: ..." and links the claimed application directly, as `clerk link --app <its id>` would. An application with no development instance then fails with "Application has no development instance", and a config write that keeps failing reports its own error
8. If the claim fails temporarily (a Platform API error or a network failure), or the workspace is managed by an integration such as Vercel, keeps `.clerk/keyless.json` and exits with the original error. A warning says to rerun `clerk link` to retry (for a managed workspace, after switching to a workspace you own), or to run `clerk link --app <app_id>` to link a different application. A Platform API error keeps its own code, e.g. `accountless_application_managed_workspace`
9. If the token is spent (expired, or the account has no organization), prints the same warning `clerk auth login` prints and continues with the normal flow below

Neither mode prompts during the claim. `--app` or an existing link skips this
step, but when you're signed out, signing in still claims the application
without the key check, as `clerk auth login` did before it had one. Only the
`clerk link` command runs this step: `clerk init`, `clerk migrate`, and the
`clerk doctor` link fix call the same `link()` without the internal
`claimKeylessApp` option.

A Clerk SDK in keyless mode writes a claim link to `.clerk/.tmp/keyless.json`
instead, which `clerk link` can't use. Claim that application in the Dashboard
with `clerk open`, then run `clerk link` and choose it, or, in agent mode, run
`clerk apps list --json` and `clerk link --app <app_id>`.

## Flow

1. Resolves the normalized git remote URL (e.g., `github.com/org/repo`) for cross-clone matching
2. Checks if already linked — if resolved via a remote URL from another clone, prints an auto-link notice
   - With `skipIfLinked` (used by `clerk init`), returns immediately
   - Otherwise, offers to upgrade the profile key to use the git remote if available, or asks to re-link
3. When run as the `clerk link` command with no link and no `--app`, claims the application `clerk init` left a claim token for (see above)
4. If `skipIfLinked` or agent mode and not already linked, tries silent autolink (detect keys → match → persist without prompting)
5. Checks for authentication (calls `clerk auth login` if needed)
6. If `--app` is provided, fetches that app directly
7. Otherwise, fetches the list of applications and scans for publishable keys in env vars / `.env` / `.env.local`
8. If a key matches an application, suggests it: "We found \<app\>. Link to this application?"
   - If the user confirms (default), links to the detected app
   - If the user declines, falls through to the interactive picker
9. If no match (or no apps exist), presents a searchable picker (type to filter by name)
   - The picker always includes a "+ Create a new application" option pinned at the top
   - Selecting it prompts for a name and creates the app via the Platform API
   - For non-interactive/CI/agent flows, create apps from the Clerk Dashboard or via the Platform API, then pass `--app <id>`
10. Stores the profile in the config file keyed by the normalized remote URL
11. Falls back to git-common-dir or the current directory path if no remote is configured

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

| Method | Endpoint                                      | Description                                                    |
| ------ | --------------------------------------------- | -------------------------------------------------------------- |
| `GET`  | `/v1/platform/applications`                   | List all applications for the authenticated user               |
| `GET`  | `/v1/platform/applications/{appId}`           | Fetch application details with instance IDs                    |
| `POST` | `/v1/platform/applications`                   | Create a new application (interactive picker)                  |
| `POST` | `/v1/platform/accountless_applications/claim` | Claim the application `clerk init` created, by its claim token |
