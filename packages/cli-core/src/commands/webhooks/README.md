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

## `clerk webhooks secret <id>`

Prints the endpoint's current signing secret. With `--rotate`, rotates first (prompts in human mode; requires `--yes` in agent mode), then prints the new secret. After rotation Svix dual-signs with old+new keys for 24h — the `svix-signature` header carries multiple space-separated entries during the grace window.

```sh
clerk webhooks secret ep_2abc123 [--rotate [--yes]]
```

Output: human mode prints the **bare** `whsec_...` on stdout (eval-friendly: `export CLERK_WEBHOOK_SIGNING_SECRET=$(clerk webhooks secret ep_...)`), with all banners on stderr. JSON/agent mode prints `{ "secret": "whsec_..." }`. Plain `secret <id>` never prompts; `--yes` is only meaningful with `--rotate`.

### API endpoints

| Method | Endpoint                               | Description                                  |
| ------ | -------------------------------------- | -------------------------------------------- |
| `GET`  | `/webhooks/{endpointID}/secret`        | Fetch the signing secret.                    |
| `POST` | `/webhooks/{endpointID}/secret/rotate` | Rotate the signing secret (`--rotate` only). |

## `clerk webhooks delete <id>`

Hard-deletes an endpoint (Svix delete is hard; no shadow table). Prompts in human mode; agent mode requires `--yes` or fails with a usage error (exit 2). Declining the prompt exits cleanly. Success prints a stderr confirmation; stdout stays empty (the route returns `200 {}`).

```sh
clerk webhooks delete ep_2abc123 [--yes]
```

### API endpoints

| Method   | Endpoint                 | Description                             |
| -------- | ------------------------ | --------------------------------------- |
| `DELETE` | `/webhooks/{endpointID}` | Delete the endpoint (returns `200 {}`). |

## `clerk webhooks update <id>`

Patches endpoint fields. Only the flags you pass are sent; everything else is omitted from the PATCH body. `--enable` maps to `{disabled: false}`, `--disable` to `{disabled: true}` (mutually exclusive; `--disabled` exists only on `create`). Passing no update flags is a usage error.

```sh
clerk webhooks update ep_2abc123 [--url ...] [--events a,b] [--description <text>] [--channels a,b] [--enable | --disable]
```

Human mode prints the updated endpoint's details on stderr. JSON mode prints the updated endpoint resource on stdout.

### API endpoints

| Method  | Endpoint                 | Description            |
| ------- | ------------------------ | ---------------------- |
| `PATCH` | `/webhooks/{endpointID}` | Patch endpoint fields. |
