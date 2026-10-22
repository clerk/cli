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
- in a folder with an init token (below), it claims that app silently and links it
- in an SDK-only folder (below), it links the account's app whose key the SDK's file holds, or stops with `usage_error` (exit 2) saying to run `clerk open`, which prints the claim link for a person
- otherwise, bare `clerk link` tries silent autolink on the key the folder's app loads
- if no app can be determined, the command exits with `usage_error` (exit 2), led by "Cannot select an application in agent mode."; when the CLI couldn't tell which key the app loads, couldn't read one of the folder's env files, couldn't list the account's apps, or found the folder's secret keys disagreeing, the error says why
- if the folder's key belongs to an app with no development instance, it stops with `instance_not_found`

After its reason, each agent stop says what to run next for what the folder
holds, with the same advice `clerk deploy` gives (`lib/unlinked-folder.ts`),
and the JSON error carries those commands, in order, as `examples`. The first
command is never `clerk link`, since it would stop the same way, except a retry
of the command that stopped. (`clerk link` can come later, e.g. after a person
claims an SDK-created app.)

| What `link` knew when it stopped                                                    | Advice                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| The app list refused `CLERK_PLATFORM_API_KEY` (401, 403, or not a Platform API key) | Replace the key, or unset it and sign in with `clerk auth login`; then the retry. Never `clerk auth login` alone: Platform API calls use the key over any session.                                                                                                                                                                                                                                                                                                                                                                                            |
| Clerk's API refused the stored session (401, 403)                                   | `clerk auth logout`, then `clerk auth login`, then the retry. Agent `clerk auth login` keeps a session that still passes Clerk's account lookup, so signing out first is what makes it sign in again. The advice says logout signs the CLI out on this whole machine, and to sign in with an account that can list applications. With an init token: logout, then `clerk auth login`, which claims the app and links the folder.                                                                                                                              |
| No credential, or a stored session the CLI can't use (expired and not refreshable)  | `clerk auth login`, then the retry: such a session already reads as signed out, so signing in replaces it, with no sign-out first. With an init token, `clerk auth login` alone: it claims the app and links the folder.                                                                                                                                                                                                                                                                                                                                      |
| The app list failed for another reason (a 5xx, a network error)                     | The retry. If it fails again, a person finds the app's ID in the Clerk Dashboard, by the key the folder holds, and runs `clerk link --app <app_id>`. For an SDK-created app with a usable claim link, the person first claims it from the link `clerk open` prints, into the account or workspace the agent's credential reaches: unclaimed, it isn't in the Dashboard. For one with no usable claim link, the fallback is its ID only if it's already claimed (the example's description says so too); linking an existing app instead is a separate choice. |
| No account app holds the folder's key                                               | For an SDK-created app with a usable claim link: `clerk open`, naming where a person must claim it (the account or workspace the agent's credential reaches), then `clerk link`. Otherwise `clerk apps list --json`, then `clerk link --app <app_id>` to link an existing app.                                                                                                                                                                                                                                                                                |
| It couldn't tell which key the app loads                                            | `clerk apps list --json`, then `clerk link --app <app_id>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| It found no key                                                                     | By what the folder holds. With no keys at all: "Pass --app <id>, or run `clerk apps list --json` and retry."                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

Signed out, every step that lists apps starts with `clerk auth login`.

The retry is `clerk link`. When `clerk init` called `link`, it's `clerk init`
with the flags it ran with (`--no-skills` included), which also ends every
piece of advice. For `clerk migrate import`, it's "run the same
`clerk migrate import` command again", never echoed, since its arguments can
hold a secret key.

When `init` just created the project (`--starter`, or `--framework` in a folder
with no project), the advice names the project's folder, and every command
starts with a `cd` into its absolute, shell-quoted path. From the folder `init`
ran in, `clerk link` would link that folder, and `clerk init` could create
another project. The absolute path works whether or not the agent's shell
keeps its folder between commands.

`clerk init` calls `link` with an internal `createIfMissing` option (the
project name) so an authenticated agent run that finds no autolink match auto-
creates a fresh app named after the project instead of erroring. The CLI does
not expose `createIfMissing` as a flag — it is library-only and reserved for
`clerk init`'s flow. It creates one only when auto-link found no key, or a
key no app in the account holds. Even then it never creates an app when `init`
would write the new app's keys over keys that may belong to a real app: when
the folder had an init token (the claim check may just have left its keys
alone), when the CLI couldn't tell which key the app loads, when an env file
couldn't be read (even one the framework doesn't load), when the app list
failed, or when the folder's secret keys disagree. One decision function in
`link()` makes this call for every way auto-link can fail to link.

## Flow

1. Resolves the normalized git remote URL (e.g., `github.com/org/repo`) for cross-clone matching
2. Checks if already linked — if resolved via a remote URL from another clone, prints an auto-link notice
   - With `skipIfLinked` (used by `clerk init`), returns immediately
   - Otherwise, offers to upgrade the profile key to use the git remote if available, or asks to re-link
   - An explicit `--app` or an existing link skips steps 3 and 4: explicit targets win
3. **Init token: claim first.** When the folder has `.clerk/keyless.json` (the claim token `clerk init` saves for an app it created signed out), `link` claims that app before anything else: it isn't in any account yet, so no picker could show it.
   - A person is asked first, with the same question `clerk auth login` asks, naming where the app goes: the signed-in account, or the workspace `CLERK_PLATFORM_API_KEY` belongs to when it's set. A signed-out person signs in first, with login's own claim off. A stored session Clerk refuses (expired and not refreshable, or rejected by the account lookup with 401 or 403) means signing in again, as before. One whose account lookup fails for another reason (a network error, a 5xx) counts as signed in: the question then names "the account you're signed in to", without signing in again. Default Yes; No is a user abort (exit 0), before any picker.
   - An agent claims without asking; one that isn't signed in can't sign in here, so it skips the claim and gets the usual agent error.
   - The token is read once and only that token is claimed (see `commands/auth/README.md`).
   - **Claimed and linked:** done. The claim check links the app only when every Clerk key in the folder is its own, or there are none.
   - **Claimed but the folder left unlinked** (another app's keys, keys it couldn't read, or a failed link), **or a stale token** (the claim returns not found): `link` goes on to match the folder's own key (steps 5 onward), but never creates an app. The claim report says why the folder wasn't linked and names no command to run next, since `link` carries on in the same run.
   - **Refused** (a workspace managed by an integration, or no organization): stops with `not_linked`, exit 1. **A temporary failure:** stops with the original error. Neither reaches the picker.
   - **The credential refused**, agent: the original error, with its code and exit 1, plus what to run next and its `examples`, as for a refused app list (above): replace or unset `CLERK_PLATFORM_API_KEY`; sign out and in again for a session Clerk's API refused (401, 403); or `clerk auth login` for one the CLI can't refresh, whose own message already says so. The token stays on disk, and signing in claims the app.
4. **SDK-only folder: match or claim page.** When the folder's only Clerk keys are in `.clerk/.tmp/keyless.json`, which a Clerk SDK writes for an app it created for itself, `link` looks for that app in the account by the file's publishable key. The CLI can't claim it: there's no token.
   - **The file has no publishable key or can't be read:** stops with `usage_error`, exit 2, in both modes, offering `clerk link --app <app_id>` (for an agent, after `clerk apps list --json`). Checked before any sign-in or app list. An agent with no credential whose folder still holds an init token is told to run `clerk auth login`, which claims that app, after this reason.
   - **A match:** links it, with or without a usable claim URL. This is also what the rerun after claiming does. When `init` calls `link` after a claim attempt, its every-key check runs first, since the SDK file's secret key needn't be the matched app's.
   - **No match, and no usable claim URL** (none, or one that isn't https): stops with `usage_error`, exit 2, in both modes. An agent isn't sent to `clerk open`, which would find no link either.
   - This step also runs after a claim that didn't link the folder: the token is gone then, so a folder whose only keys are the SDK's is SDK-only.
   - An env file the framework doesn't load (Nuxt loads only `.env`) that can't be read doesn't skip this step.
   - **No match, person:** opens the app's claim page in the browser, says to claim it into the account the rerun will search and then rerun the command (`clerk link`; `clerk init` and `clerk migrate import` name themselves, the import without echoing its arguments), and always adds a line pointing at `clerk open --print` for a browser that opened on another screen. It never prints the URL, which carries a claim token. Exits 1 with no error line; telemetry records outcome `incomplete` with `not_linked`, so `clerk link && clerk deploy` stops there. When no browser can be opened, the message leads with "Couldn't open a browser here".
   - **No match, agent:** stops with `usage_error`, exit 2, saying to run `clerk open`, naming where a person must claim the app, then `clerk link`.
   - **The app list fails:** a person gets the original error; an agent gets `usage_error`, exit 2, naming the failed list, then the advice for a failed list (see Agent Mode). Never the picker, which used to offer only "create a new application" after a server error.
5. If `skipIfLinked` or in agent mode, tries silent autolink on the key the folder's app loads (detect → match → persist without prompting)
6. Checks for authentication (calls `clerk auth login` if needed, with login's own claim off)
7. If `--app` is provided, fetches that app directly
8. Otherwise, fetches the list of applications and matches the key the folder's app loads (see Key Detection)
9. If the key matches an application, suggests it: "We found \<app\>. Link to this application?"
   - If the user confirms (default), links to the detected app
   - If the user declines, falls through to the interactive picker
   - If the CLI couldn't tell which key the app loads, it says why (even when the account has no apps) and goes straight to the picker
10. If no match (or no apps exist), presents a searchable picker (type to filter by name)
    - The picker includes a "+ Create a new application" option pinned at the top, except when `init`'s key check applies (step 11) and the folder holds Clerk keys: a new app's keys couldn't match them. With no app left to choose, `init` stops with `not_linked`
    - When `init`'s key check applies and no app could pass it (a key line can't be read, or a value the CLI can't read as a Clerk key, such as a placeholder or a publishable key that doesn't decode; a legacy `test_`/`live_` key can still match exactly), `link` stops with `not_linked` before the picker, naming the variable and its file. That reason comes first in the message, ahead of files that disagree. Files that disagree still get the picker: they may be one app's development and production keys
    - Selecting it prompts for a name and creates the app via the Platform API
    - For non-interactive/CI/agent flows, create apps from the Clerk Dashboard or via the Platform API, then pass `--app <id>`
11. **`clerk init`'s key check:** when `init` calls `link` after a claim attempt (`onlyIfFolderKeysMatch`), the link is saved only if every Clerk key in the folder belongs to the chosen app. Otherwise nothing is saved and `link` stops with `not_linked`, exit 1, naming the key and its file: `init` writes the linked app's keys next, and the folder would otherwise point at an app it doesn't run on. "Couldn't tell" stops too.
12. Stores the profile in the config file keyed by the normalized remote URL
13. Falls back to git-common-dir or the current directory path if no remote is configured

`link()` returns an outcome: linked, or `claim_page_opened`. `clerk init` and
`clerk migrate import` stop with exit 1 on `claim_page_opened` instead of
going on as if the folder were linked, and `clerk doctor --fix` reports the
link fix as not applied.

## Key Detection

`clerk link` matches on one key: the publishable key the folder's app loads,
from `findLinkKey` in `src/lib/autolink.ts`, which reads it with the shared
folder key reader (`readFolderKeys` in `src/lib/local-keys.ts`). It never
falls back to another file's key when that one matches nothing: matching a key
the app doesn't load would link an app the folder doesn't run on.

Framework detection (`src/lib/framework.ts`) reads `package.json` to determine
the publishable key's variable name (e.g., `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`
for Next.js, `CLERK_PUBLISHABLE_KEY` as fallback) and the order the framework
loads its env files in.

### Which key the app loads

1. **An exported variable** (highest priority): the framework's own name, then `CLERK_PUBLISHABLE_KEY`
2. **The framework's env files, in its documented development load order**, highest priority first:

   | Framework                                                               | Files                                                              |
   | ----------------------------------------------------------------------- | ------------------------------------------------------------------ |
   | Next.js                                                                 | `.env.development.local`, `.env.local`, `.env.development`, `.env` |
   | The Vite family (Astro, Vue, React Router, TanStack Start, React, Vite) | `.env.development.local`, `.env.development`, `.env.local`, `.env` |
   | Nuxt                                                                    | `.env` only                                                        |

   React counts as the Vite family because the CLI reads only Vite's `VITE_` names for React apps.

3. **Any other framework, or none detected:** all four files are read. When they hold different publishable keys, the key is undecided: the CLI can't tell which one the app loads.

A framework's own variable name wins over the generic one, wherever each is: a
generic `CLERK_PUBLISHABLE_KEY` exported in the shell doesn't beat
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` in `.env.local`. Next.js, Astro, Nuxt,
and Vue never read the generic name (Clerk's SDK source), so for them it
doesn't count at all; React, React Router, and TanStack Start read it as a
fallback. Expo and plain Vite keep the generic name as a fallback until their
SDKs are checked, and for Express, Fastify, iOS, Android, and a folder with no
detected framework it's the only name the CLI reads.

### Couldn't tell

The CLI never auto-links, and a person gets no "Link to this application?"
suggestion, when:

- a Clerk key line can't be read (indented, spaced around `=`, `KEY: value`): the app may load it;
- the files disagree and no documented order picks one;
- an env file can't be read.

A person sees a line saying why, then the picker. An agent gets the
not-linked usage error with the reason.

### Matching

The key is matched against all applications returned by
`GET /v1/platform/applications` by exact publishable key.

## API Endpoints

| Method | Endpoint                                      | Description                                                    |
| ------ | --------------------------------------------- | -------------------------------------------------------------- |
| `GET`  | `/v1/platform/applications`                   | List all applications for the authenticated user               |
| `GET`  | `/v1/platform/applications/{appId}`           | Fetch application details with instance IDs                    |
| `POST` | `/v1/platform/applications`                   | Create a new application (interactive picker)                  |
| `POST` | `/v1/platform/accountless_applications/claim` | Claim the app `clerk init` created (folder with an init token) |
