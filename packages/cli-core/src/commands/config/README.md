# Config Commands

Manage Clerk instance configuration.

Two modes exist, picked automatically:

- **Account mode** (default) — full instance config document via the Platform API. Used whenever the project is linked or `--app` is passed; requires an account (`clerk auth login` or `CLERK_PLATFORM_API_KEY`).
- **Accountless mode** — a reduced set of settings via the Backend API, using only the instance secret key the project already has on disk. No account, no login, and no platform API key required. See [Accountless mode](#accountless-mode).

## Commands

### `clerk config pull`

Fetches the instance configuration from the Clerk Platform API and outputs it as JSON.

```sh
clerk config pull
clerk config pull --app app_123
clerk config pull --instance prod
clerk config pull --output clerk-config.json
clerk config pull --keys auth_email session
```

#### Options

| Flag               | Description                                                                                |
| ------------------ | ------------------------------------------------------------------------------------------ |
| `--app <id>`       | Application ID to target directly (works from any directory)                               |
| `--instance <id>`  | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development.        |
| `--output <file>`  | Write config to a file instead of stdout                                                   |
| `--keys <keys...>` | Top-level config keys to retrieve, separated by spaces or commas (e.g. auth_email session) |

#### Requirements

- Requires either:
  - a linked Clerk project in the current directory, or
  - `--app <id>` to target an application directly
- Authenticated via `CLERK_PLATFORM_API_KEY`, `clerk auth login`, or the interactive human-mode prompt
- **Or neither**: an unlinked project holding an instance secret key falls back to [accountless mode](#accountless-mode), which needs no account

#### API Endpoints

All requests are made against the Clerk Platform API (default `https://api.clerk.com`, overridable via `CLERK_PLATFORM_API_URL`).

| Method | Endpoint                                                          | Description                                                                                                      |
| ------ | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Fetches the full instance configuration as JSON. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |

---

### `clerk config schema`

Fetches the JSON Schema for an instance's configuration from the Clerk Platform API and outputs it as JSON.

```sh
clerk config schema
clerk config schema --app app_123
clerk config schema --instance prod
clerk config schema --output config-schema.json
clerk config schema --keys auth_email session
```

#### Options

| Flag               | Description                                                                                    |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| `--app <id>`       | Application ID to target directly (works from any directory)                                   |
| `--instance <id>`  | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development.            |
| `--output <file>`  | Write schema to a file instead of stdout                                                       |
| `--keys <keys...>` | Top-level schema sections to retrieve, separated by spaces or commas (e.g. auth_email session) |

#### Requirements

- Requires either:
  - a linked Clerk project in the current directory, or
  - `--app <id>` to target an application directly
- Authenticated via `CLERK_PLATFORM_API_KEY`, `clerk auth login`, or the interactive human-mode prompt
- Account-only: in an unlinked project holding an instance secret key this exits with an error explaining that the schema describes the account-level config document (see [accountless mode](#accountless-mode))

#### API Endpoints

| Method | Endpoint                                                                 | Description                                                                                                                                                             |
| ------ | ------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/platform/applications/{appID}/instances/{instanceID}/config/schema` | Fetches the config JSON Schema. Supports optional `keys` query param to filter to specific config keys. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |

---

### `clerk config patch`

Partially updates instance configuration using a PATCH request. Only the fields you include in the payload are modified; everything else remains unchanged.

Input can be provided via `--json` (inline), `--file` (path to a JSON file), or piped to stdin. When running interactively, the command shows the payload and prompts for confirmation before sending.

```sh
clerk config patch --json '{"session":{"lifetime":3600}}'
clerk config patch --app app_123 --json '{"session":{"lifetime":3600}}'
clerk config patch --file partial-config.json
cat partial-config.json | clerk config patch
clerk config patch --file partial-config.json --dry-run
```

#### Options

| Flag              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--app <id>`      | Application ID to target directly (works from any directory)                        |
| `--instance <id>` | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development. |
| `--file <path>`   | Read config JSON from a file                                                        |
| `--json <string>` | Pass config JSON inline (takes priority over `--file`)                              |
| `--dry-run`       | Validate server-side and preview the projected result without persisting changes    |
| `--yes`           | Skip confirmation prompts                                                           |

#### Requirements

- Requires either:
  - a linked Clerk project in the current directory, or
  - `--app <id>` to target an application directly
- Authenticated via `CLERK_PLATFORM_API_KEY`, `clerk auth login`, or the interactive human-mode prompt
- **Or neither**: an unlinked project holding an instance secret key falls back to [accountless mode](#accountless-mode), which needs no account

#### API Endpoints

| Method  | Endpoint                                                          | Description                                                                                                                                                                                   |
| ------- | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PATCH` | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Partially updates instance configuration. Sends `?dry_run=true` under `--dry-run` to validate and preview without persisting. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |

---

### `clerk config put`

Replaces the entire instance configuration using a PUT request. The payload you send becomes the complete configuration, overwriting all existing values.

Input can be provided via `--json` (inline), `--file` (path to a JSON file), or piped to stdin. When running interactively, the command shows a destructive-action warning and prompts for confirmation before sending.

```sh
clerk config put --file full-config.json
clerk config put --app app_123 --file full-config.json
clerk config put --json '{"session":{"lifetime":3600},"sign_in":{"enabled":true}}'
cat full-config.json | clerk config put
clerk config put --file full-config.json --dry-run
```

#### Options

| Flag              | Description                                                                         |
| ----------------- | ----------------------------------------------------------------------------------- |
| `--app <id>`      | Application ID to target directly (works from any directory)                        |
| `--instance <id>` | Instance to target (`dev`, `prod`, or a full instance ID). Defaults to development. |
| `--file <path>`   | Read config JSON from a file                                                        |
| `--json <string>` | Pass config JSON inline (takes priority over `--file`)                              |
| `--dry-run`       | Validate server-side and preview the projected result without persisting changes    |
| `--yes`           | Skip confirmation prompts                                                           |

#### Requirements

- Requires either:
  - a linked Clerk project in the current directory, or
  - `--app <id>` to target an application directly
- Authenticated via `CLERK_PLATFORM_API_KEY`, `clerk auth login`, or the interactive human-mode prompt
- Account-only: in an unlinked project holding an instance secret key this exits with an error pointing at `clerk config patch` (see [accountless mode](#accountless-mode))

#### API Endpoints

| Method | Endpoint                                                          | Description                                                                                                                                                                                   |
| ------ | ----------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PUT`  | `/v1/platform/applications/{appID}/instances/{instanceID}/config` | Replaces the full instance configuration. Sends `?dry_run=true` under `--dry-run` to validate and preview without persisting. Authenticated via `Bearer` token from `CLERK_PLATFORM_API_KEY`. |

---

## Accountless mode

A accountless application created by `clerk init` has no Clerk account behind it until someone claims it, so the Platform API — which authenticates an _account_ — cannot reach it. `clerk config pull` and `clerk config patch` fall back to Clerk's Backend API, authenticated with the instance secret key the project already keeps locally, so an unclaimed app can be configured without logging in.

### When it engages

Both must hold, otherwise the account-authenticated path runs unchanged:

1. No `--app` was passed.
2. No linked project in the current directory.

**Account credentials are not part of this decision.** Accountless mode works with or without `CLERK_PLATFORM_API_KEY` and with or without a `clerk auth login` session — the instance secret key is sufficient on its own. What rules it out is an explicit destination (`--app` or a linked profile), because that names an application the local secret key may not belong to.

When credentials _are_ present and the directory simply isn't linked, the command prints a warning that it's using the reduced key-based view and points at `clerk link`, so the narrower output is never a silent surprise.

The secret key is resolved the way the app itself would resolve one, and this order is shared by every accountless-capable command (`lib/keyless-target.ts`):

1. `CLERK_SECRET_KEY`, or the framework's secret key variable (e.g. `NUXT_CLERK_SECRET_KEY`), in the environment
2. `.env`, then `.env.local` — the later file wins
3. `.clerk/.tmp/keyless.json` — the keys a Clerk SDK minted for itself when the app ran with no keys configured

A key that doesn't start with `sk_` is rejected. The SDK file comes last because SDKs only create their own application when nothing else supplies keys.

### Payload shape

The Backend API has no single config document — it exposes independent resources — so accountless payloads name them directly instead of translating between the two shapes. Each top-level key maps 1:1 to one endpoint:

```sh
clerk config patch --json '{
  "instance": { "support_email": "dev@acme.com" },
  "organization_settings": { "enabled": true }
}'
```

| Top-level key                | Endpoint                                  | Readable | Covers                                                                              |
| ---------------------------- | ----------------------------------------- | -------- | ----------------------------------------------------------------------------------- |
| `instance`                   | `/v1/instance`                            | Yes      | Support email, home URL, allowed origins                                            |
| `communication`              | `/v1/instance/communication`              | Yes      | Blocked country codes and communication settings                                    |
| `restrictions`               | `/v1/instance/restrictions`               | No       | Allowlist / blocklist sign-up restrictions                                          |
| `organization_settings`      | `/v1/instance/organization_settings`      | Yes      | Organizations: enabled, membership limits, domains, creation defaults               |
| `protect`                    | `/v1/instance/protect`                    | Yes      | Bot protection                                                                      |
| `oauth_application_settings` | `/v1/instance/oauth_application_settings` | Yes      | Dynamic OAuth client registration                                                   |
| `instance_settings`          | `/v1/beta_features/instance_settings`     | No       | `test_mode`, `progressive_sign_up`, `from_email_address`, `restricted_to_allowlist` |

Any other top-level key exits with a usage error naming the supported ones. Most of them (`session`, `sign_up`, `auth_email`, …) are genuinely account-only and the error points at `clerk auth login`. A handful — `enterprise_connections`, `saml_connections`, `oauth_applications`, `domains` — are BAPI resource _collections_ reachable on an unclaimed application today; they're just not part of this config document, so the error points at `clerk api /<resource>` instead of a login that wouldn't add them anyway.

`instance_settings` is backed by a beta route, and is the only way to reach those four auth-config fields without an account — which is why it's included.

`clerk config pull` returns the same envelope. `restrictions` and `instance_settings` are omitted because the Backend API has no read route for either (see the Readable column above) — a `pull` run to confirm a write to them will not show the field, which does not mean the write failed. Asking for either by name prints a warning rather than failing.

`GET /v1/instance` returns a subset of what `PATCH /v1/instance` accepts — `support_email`, for example, is writable but not readable. Fields the read omits have no "before" value to compare against, so they always appear as additions in the diff and never trigger "No changes detected". The write itself is unaffected: patching a field to the value it already holds is a no-op server-side.

### Round-trip verification

A 200 or 204 from a accountless write only means Clerk's Backend API accepted the request — it silently drops fields it doesn't recognize inside a group instead of rejecting them, and at least one route (`PATCH /v1/instance` with `allowed_origins: null` or `[]`) accepts a value it then ignores. Printing "Config pushed successfully" off the HTTP status alone would paper over both.

After a write, the CLI checks every field it sent against the PATCH response body, and against nothing else. Fields whose value round-trips are reported as applied; fields the response doesn't reflect are named explicitly instead of folded into an unconditional success line.

A follow-up GET looks like stronger evidence and is in fact weaker. BAPI omits writable-but-not-readable fields from its reads — `instance.support_email` is accepted and never echoed — and reads are eventually consistent, so a GET issued straight after a write routinely returns the pre-write value. Verifying against one reports perfectly good writes as dropped. This applies equally to the six groups that do have a GET route: the response body is the only read that is guaranteed to be about _this_ write.

That leaves `PATCH /v1/instance`, which answers `204` with no body at all. Nothing can confirm it after the fact, so the check moves to before the request instead: the fields that route accepts are a closed set in BAPI's own schema (`additionalProperties: false`), and the legacy-named `assertKeylessPayload` rejects anything outside it. This matters because that route is also the one people reach for when trying to enable password auth or a social provider — none of which it accepts, and all of which it used to swallow with a `204` and a success message. The group is still reported as unconfirmed, and contributes no state to the printed envelope rather than a possibly-stale re-read.

`restrictions` and `instance_settings` have no GET route, but both echo their new state in the PATCH response, so their writes verify normally.

### Differences from account mode

| Behavior           | Account mode                             | Accountless mode                                                                                                                      |
| ------------------ | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Coverage           | Full config document                     | Seven Backend API resources                                                                                                           |
| `--instance`       | Selects dev/prod                         | Usage error — the secret key already targets exactly one instance                                                                     |
| `--dry-run`        | Server-side validation of the projection | Local diff only; nothing is sent                                                                                                      |
| `config put`       | Replaces the whole document              | Errors — no full document exists to replace                                                                                           |
| `config schema`    | Returns the JSON Schema                  | Errors — the schema describes the account-level document                                                                              |
| Write confirmation | Trusts the response body outright        | Verifies each sent field round-tripped and names what couldn't be confirmed (see [Round-trip verification](#round-trip-verification)) |

Run `clerk auth login` to claim the application; auto-claim links it, and every config command then uses account mode with full coverage.

### API Endpoints (accountless mode)

All requests go to the Clerk Backend API (default `https://api.clerk.dev`, overridable via `CLERK_BACKEND_API_URL`), authenticated with a `Bearer sk_…` instance secret key.

| Method  | Endpoint                                  | Description                                                                                                                                                             |
| ------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`   | `/v1/instance`                            | Reads instance settings for `config pull` and for the pre-write diff.                                                                                                   |
| `PATCH` | `/v1/instance`                            | Updates instance settings. Answers `204` with no body, so the write can't be confirmed afterwards — field names are validated against BAPI's schema beforehand instead. |
| `GET`   | `/v1/instance/communication`              | Reads communication settings (e.g. blocked country codes) for `config pull` and for the pre-write diff.                                                                 |
| `PATCH` | `/v1/instance/communication`              | Updates communication settings.                                                                                                                                         |
| `PATCH` | `/v1/instance/restrictions`               | Updates sign-up restrictions (allowlist, blocklist). No read route, but the response echoes the new state, so the write verifies normally.                              |
| `GET`   | `/v1/instance/organization_settings`      | Reads organization settings for `config pull` and for the pre-write diff.                                                                                               |
| `PATCH` | `/v1/instance/organization_settings`      | Updates organization settings.                                                                                                                                          |
| `GET`   | `/v1/instance/protect`                    | Reads bot-protection settings for `config pull` and for the pre-write diff.                                                                                             |
| `PATCH` | `/v1/instance/protect`                    | Updates bot-protection settings.                                                                                                                                        |
| `GET`   | `/v1/instance/oauth_application_settings` | Reads dynamic OAuth client registration settings for `config pull` and for the pre-write diff.                                                                          |
| `PATCH` | `/v1/instance/oauth_application_settings` | Updates dynamic OAuth client registration settings.                                                                                                                     |
| `PATCH` | `/v1/beta_features/instance_settings`     | Updates `test_mode`, `progressive_sign_up`, `from_email_address`, `restricted_to_allowlist`. No read route, but the response echoes the new state.                      |
