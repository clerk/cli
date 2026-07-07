# `clerk impersonate`

Create a short-lived actor token for a Clerk user and print the sign-in URL that
lets you sign in as them ("impersonate"). Alias: `clerk imp`.

## Auth

`clerk impersonate` and `clerk impersonate revoke` both **require `clerk auth
login`** — there is no `--secret-key`-only bypass. The actor token's
`actor.sub` field is stamped with your logged-in email (`cli:<email>`, or
`cli:<email>+<context>` with `--actor <context>`) so every impersonation
session is traceable back to a real Clerk account, not just an API key.

## Usage

```sh
clerk imp                                    # pick a user interactively, then confirm
clerk imp user_2x9k                          # impersonate a specific user
clerk imp alice@example.com                  # resolve by exact email match
clerk imp alice --open                       # open the sign-in URL in your browser immediately
clerk imp user_2x9k --print                  # print the URL only, no prompt, no browser
clerk imp user_2x9k --yes --expires-in 900   # skip confirmation, 15-minute token
clerk imp user_2x9k --actor oncall           # stamp the actor as cli:<you>+oncall
clerk imp revoke act_29w9...                 # revoke a pending actor token
```

## Options

| Flag                     | Applies to | Description                                                                                                      |
| ------------------------ | ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `[user]`                 | create     | `user_...` ID, exact email, or fuzzy search term. Omit to pick interactively.                                    |
| `<actorTokenId>`         | revoke     | Actor token ID to revoke (required)                                                                              |
| `--secret-key <key>`     | both       | Backend API secret key to use                                                                                    |
| `--app <id>`             | both       | Application ID to target (works from any directory)                                                              |
| `--instance <id>`        | both       | Instance to target (`dev`, `prod`, or a full instance ID)                                                        |
| `--actor <context>`      | create     | Extra context appended to the actor stamp: `cli:<email>+<context>`                                               |
| `--expires-in <seconds>` | create     | Actor token lifetime in seconds, integer >= 1. Defaults to 3600 (1 hour), matching the dashboard's short expiry. |
| `--open`                 | create     | Open the sign-in URL in your browser immediately, skipping the prompt                                            |
| `--print`                | create     | Print the sign-in URL only — no prompt, no browser                                                               |
| `--yes`                  | create     | Skip the confirmation prompt                                                                                     |

`clerk impersonate revoke` never prompts for confirmation — it's a low-risk
operation on an already-pending token.

## User resolution

Given `[user]`:

1. `/^user_[A-Za-z0-9]+$/` → used directly, no lookup.
2. Contains `@` → exact match via `GET /v1/users?email_address=<email>`.
3. Otherwise → fuzzy match via `GET /v1/users?query=<term>`.

Then:

- 0 matches → usage error naming the searched app and instance, e.g.
  `No user found matching "alice@example.com" on My Application (development).`
- 1 match → used directly.
- 2+ matches, human mode → an interactive picker (the picker's search box
  always starts empty — there's no way to prefill it with your original
  search term; see `commands/users/interactive/pick-user.ts`).
- 2+ matches, agent mode → usage error listing candidate user IDs so you can
  re-run with a specific `user_...` ID.
- No `[user]` argument, human mode → the interactive picker.
- No `[user]` argument, agent mode → usage error (agent mode never prompts).

## Instance resolution

The app comes from `--app`, the linked profile, or — in human mode with no
linked project — an interactive app picker. In human mode, whenever the
resolved app has more than one instance and no `--instance` flag was passed,
`clerk impersonate` and `clerk impersonate revoke` prompt
"Select an instance to use:" instead of silently defaulting to development —
even in a linked project. Users usually exist on only one instance (and actor
tokens are instance-scoped), so a silent development default makes lookups and
revokes fail confusingly. Agent mode never prompts and keeps the development
default; `--instance` or `--secret-key` always pins the instance.

## Confirmation and the production guardrail

In human mode, unless `--yes` is passed, `clerk impersonate` asks
"Impersonate `<user>` on `<app>` (`<instance>`)?" defaulting to **No**. When
the target instance's label is `production`, a warning is printed above the
prompt:

> production — signs you in as this user and bypasses their MFA. may count
> against your monthly impersonation quota.

The CLI cannot read your live impersonation quota (Backend API has no
endpoint for it), so this is a generic reminder, not a number. Agent mode
never prompts and proceeds directly.

## Output modes

The sign-in URL from BAPI's response is always printed **verbatim** via
`log.data()` — never reconstructed client-side. Human mode also prints a
`Revoke with: clerk imp revoke <id>` hint to stderr — BAPI has no list
endpoint for actor tokens, so creation is the only moment the ID is visible.

| Condition                                  | Behavior                                                                                                                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--print`                                  | Print the URL, exit. No prompt, no browser.                                                                                                                            |
| `--open`                                   | Print the URL, open the browser immediately. No prompt.                                                                                                                |
| TTY, no `--print`/`--open`                 | Print the URL, then prompt "Press Enter to open in your browser (Ctrl+C to skip)".                                                                                     |
| Non-TTY, human mode, no `--print`/`--open` | Same as `--print` — never hangs waiting for input that can't arrive.                                                                                                   |
| Agent mode                                 | Emit one JSON line via `log.data()`: `{ url, id, userId, actor, appId, appLabel, instanceId, instanceLabel, expiresInSeconds }`. Never prompts, never opens a browser. |

## Clerk API endpoints

| Method | Path                              | Used by                                              |
| ------ | --------------------------------- | ---------------------------------------------------- |
| `GET`  | `/v1/users?email_address=<email>` | Resolving `[user]` when it contains `@`              |
| `GET`  | `/v1/users?query=<term>`          | Resolving `[user]` fuzzy search                      |
| `GET`  | `/v1/users?query=<term>&limit=21` | The interactive user picker (`pickUser`)             |
| `POST` | `/v1/actor_tokens`                | Creating the actor token (`clerk impersonate`)       |
| `POST` | `/v1/actor_tokens/{id}/revoke`    | Revoking an actor token (`clerk impersonate revoke`) |

`POST /v1/actor_tokens` returns `402` when impersonation isn't enabled on the
app's subscription plan, and `422` when the impersonation quota is exhausted
(the CLI surfaces `used`/`limit` from the error's `meta` when BAPI includes
them).

No part of this command is mocked or stubbed.
