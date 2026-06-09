# Webhooks Commands

> The 13 PLAPI webhook routes these commands call are being built in parallel in `clerk_go` and may not exist yet in every environment. The CLI is built against the final spec's request/response shapes; unit tests mock the PLAPI layer.

Manage webhook endpoints and deliveries for the linked instance: CRUD, delivery inspection, local forwarding (`listen`), replay, and offline signature verification.

## Group-level options

Inherited by every subcommand via `optsWithGlobals()`:

| Option            | Description                                                                                           |
| ----------------- | ----------------------------------------------------------------------------------------------------- |
| `--app <id>`      | Application ID to target (works from any directory).                                                  |
| `--instance <id>` | Instance to target (`dev`, `prod`, or a full instance ID).                                            |
| `--json`          | Force machine output in a human TTY. Agent mode (`isAgent()`) always behaves as if `--json` were set. |

Auth: every subcommand except `verify` is gated by a `preAction` hook calling `getAuthToken()` (accepts `ak_` keys or an OAuth session; never `sk_`). `verify` is pure offline HMAC — no auth, and it ignores `--app`/`--instance`.

Output contract: stdout carries bare domain JSON via `log.data()` (pipeable); stderr carries human UI and, in agent mode, structured error JSON `{"error":{code,message,docsUrl?}}`. No `{ok,data,error}` envelope. Exit codes: 0 success, 1 failure, 2 usage error, 130 SIGINT.

Pagination: list-shaped commands fetch ONE page (`--limit` 1-250, default 100). When `cursor.has_next_page` is true, the next `--iterator` value is printed as a stderr hint. The `--iterator` flag value is sent on the wire as the `starting_after` query param.

All routes below are relative to `/v1/platform/applications/{applicationID}/instances/{envOrInsID}`.

## `clerk webhooks list`

Lists webhook endpoints for the instance.

```sh
clerk webhooks list [--limit N] [--iterator C]
```

| Option           | Description                                       |
| ---------------- | ------------------------------------------------- |
| `--limit <n>`    | Maximum endpoints to return (1-250, default 100). |
| `--iterator <c>` | Pagination cursor from the previous response.     |

Human mode prints an `ID / URL / STATUS / EVENTS` table on stderr. JSON mode prints the full `{ data, cursor }` response on stdout.

### API endpoints

| Method | Endpoint    | Description                        |
| ------ | ----------- | ---------------------------------- |
| `GET`  | `/webhooks` | List webhook endpoints (one page). |

## `clerk webhooks get <id>`

Prints one endpoint's configuration. A PLAPI 404 maps to error code `webhook_endpoint_not_found`.

```sh
clerk webhooks get ep_2abc123
```

Human mode prints labeled detail rows on stderr. JSON mode prints the bare endpoint resource on stdout.

### API endpoints

| Method | Endpoint                 | Description         |
| ------ | ------------------------ | ------------------- |
| `GET`  | `/webhooks/{endpointID}` | Fetch one endpoint. |

## `clerk webhooks event-types`

Lists the Svix event-type catalog for the instance (`--limit`/`--iterator` as in `list`). Archived types are marked in human output.

```sh
clerk webhooks event-types [--limit N] [--iterator C]
```

### API endpoints

| Method | Endpoint                | Description                             |
| ------ | ----------------------- | --------------------------------------- |
| `GET`  | `/webhooks/event_types` | List the event-type catalog (one page). |
