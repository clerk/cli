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

## `clerk webhooks create`

Creates an endpoint (always `version: 1`), then fetches and prints its signing secret. The backend lazily provisions the Svix app on the first create. Two network calls, client-orchestrated.

```sh
clerk webhooks create --url <https://...> [--events user.created,...] [--description <text>] [--channels a,b] [--disabled]
```

JSON mode emits the endpoint resource FLAT with one extra field: `signing_secret`. Human mode prints the details plus the unmasked secret on stderr.

Partial failure: if `POST /webhooks` succeeds but the secret fetch fails, the command exits 1 with `Endpoint created (id: ep_...) but the signing secret could not be fetched. Run 'clerk webhooks secret ep_...' to retrieve it.` — no silent orphan.

### API endpoints

| Method | Endpoint                        | Description                                       |
| ------ | ------------------------------- | ------------------------------------------------- |
| `POST` | `/webhooks`                     | Create the endpoint (lazily provisions Svix app). |
| `GET`  | `/webhooks/{endpointID}/secret` | Fetch the new endpoint's signing secret.          |

## `clerk webhooks messages`

Lists recent deliveries (msg IDs, event type, status, full payload) for an endpoint — the discovery feed for `replay <msg_id>`. `--endpoint` defaults to the instance's persisted relay endpoint; without either, it's a usage error.

```sh
clerk webhooks messages [--endpoint <ep_id>] [--status success|pending|fail|sending] [--limit N] [--iterator C]
```

Human mode prints an `ID / EVENT TYPE / STATUS / CREATED` table on stderr (payloads only in JSON mode). JSON mode prints the full `{ data, cursor }` response, payloads included.

### API endpoints

| Method | Endpoint                          | Description                                            |
| ------ | --------------------------------- | ------------------------------------------------------ |
| `GET`  | `/webhooks/{endpointID}/messages` | List attempted deliveries (one page, optional status). |

## `clerk webhooks replay`

Dual-mode:

- `replay <msg_id>` resends one delivery (same `svix-id`). `--endpoint` defaults to the relay endpoint. No prompt — a single targeted resend is not destructive.
- `replay --since <ISO> [--until <ISO>]` bulk-recovers failed deliveries in a window. `--endpoint` is **required** (bulk recovery never guesses), and it prompts unless `--yes` (agent mode requires `--yes`).

`<msg_id>` and `--since` are mutually exclusive; passing both or neither is a usage error, as is `--until` without `--since`. Both operations are async on the Svix side — success means queued (`200 {}`), stdout stays empty.

```sh
clerk webhooks replay [<msg_id>] [--endpoint <ep_id>] [--since <ISO> [--until <ISO>]] [--yes]
```

### API endpoints

| Method | Endpoint                                             | Description                                                  |
| ------ | ---------------------------------------------------- | ------------------------------------------------------------ |
| `POST` | `/webhooks/{endpointID}/messages/{messageID}/resend` | Resend one delivery (`<msg_id>` mode).                       |
| `POST` | `/webhooks/{endpointID}/recover`                     | Recover a window: body `{ since, until? }` (`--since` mode). |

## `clerk webhooks trigger <event_type>`

Sends an example event of the given type. Because `send_example` returns `200 {}` asynchronously, the CLI first validates the type against the event-type catalog (paging through it) and fails fast with error code `unknown_event_type` — otherwise an invalid type would exit 0 and deliver nothing. `--endpoint` defaults to the relay endpoint.

```sh
clerk webhooks trigger user.created [--endpoint <ep_id>]
```

### API endpoints

| Method | Endpoint                              | Description                                      |
| ------ | ------------------------------------- | ------------------------------------------------ |
| `GET`  | `/webhooks/event_types`               | Validate the event type against the catalog.     |
| `POST` | `/webhooks/{endpointID}/send_example` | Send the example event: body `{ "event_type" }`. |

## `clerk webhooks open`

Fetches a single-use Svix portal URL and opens it in the browser via `openBrowser()` (which never throws — on failure the URL is printed as a fallback). JSON/agent mode prints `{ "url": "..." }` and does not launch a browser. Backed by the Svix `DashboardAccess` API in v0.64.1; switch to `AppPortalAccess` on SDK upgrade.

```sh
clerk webhooks open
```

### API endpoints

| Method | Endpoint        | Description                               |
| ------ | --------------- | ----------------------------------------- |
| `POST` | `/webhooks/url` | Fetch the portal URL (request body `{}`). |

## `clerk webhooks verify`

Verifies a Svix webhook signature **locally**: HMAC-SHA256 over `{id}.{timestamp}.{body}` with the base64-decoded `whsec_` suffix, constant-time compare, any-match across space-separated `v1,<sig>` header entries (rotation grace windows produce multiple entries). No network calls, no auth gate (`--app`/`--instance` are ignored). Exit 0 = signature matched; exit 1 = mismatch (with a humanized timestamp-skew hint when the timestamp is >5 minutes off); exit 2 = bad inputs.

Agent/`--json` mode: success prints `{ "valid": true }` on stdout; a mismatch exits 1 with error code `invalid_webhook_signature` in the structured stderr error.

```sh
clerk webhooks verify --secret whsec_... (--delivery @event.json | --payload @body.json --id msg_... --timestamp <unix_seconds> --signature v1,...)
```

| Option               | Description                                                                                               |
| -------------------- | --------------------------------------------------------------------------------------------------------- |
| `--secret <whsec>`   | Always required. A flag, never a positional — secrets must not land in argv positionals.                  |
| `--delivery <file>`  | One `listen` event NDJSON line (`@file` or `-`); supplies `id`, `timestamp`, `signature`, and the body.   |
| `--payload <file>`   | Raw body as `@file` or `-` (bare inline JSON rejected; shells mangle it).                                 |
| `--id <msg_id>`      | The `svix-id` header (first HMAC pre-image segment).                                                      |
| `--timestamp <secs>` | The `svix-timestamp` header — Unix epoch seconds, integer.                                                |
| `--signature <sig>`  | The raw `svix-signature` header value; may carry multiple space-separated `v1,<sig>` entries (any-match). |

Explicit flags override fields parsed from `--delivery`. A `listen` event line saved to a file is directly consumable here.

### API endpoints

None — pure offline computation.

## `clerk webhooks listen`

Dials the Svix relay (`wss://api.relay.svix.com/api/v1/listen/`), registers a **persistent** per-instance relay endpoint pointing at `https://play.svix.com/in/<token>/`, and forwards incoming deliveries to a local handler.

```sh
clerk webhooks listen [--forward-to <url>] [--events <list>] [--skip-verify] [--headers k:v,...]
```

| Option               | Description                                                                                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--forward-to <url>` | Local URL to POST deliveries to. Omitted: events are received, verified, and printed with `forward_status: null`.                                                                              |
| `--events <list>`    | Sets `filter_types` on the relay endpoint. If the persisted endpoint has different filters it is PATCHed — with a warning, since other `listen` sessions share this instance's relay endpoint. |
| `--skip-verify`      | Skip per-delivery HMAC verification.                                                                                                                                                           |
| `--headers <pairs>`  | Comma-separated `k:v` extras on the forwarded POST (split on the FIRST colon). The delivery's `svix-*` headers always win.                                                                     |

Behavior notes:

- **Relay token**: 10 random base62 chars, raw on the wire (no `c_` prefix), persisted per instance in the CLI config (`relay.<instanceId>.token`). Close code 1008 = token collision → new token generated, persisted, redialed, and the endpoint URL re-pointed.
- **Keepalive**: the relay server pings ~every 21s, but Bun's client WebSocket auto-pongs below the JS API (no ping events). After 30s of silence the client sends an active `ws.ping()` probe — writes to a dead link surface as close/error, which redials with the same token. Reconnects never change the relay URL.
- **Per-delivery output**: human mode prints `time --> event_type msg_…` then `<-- status method path ms` via `log.ui` (bypasses the stderr throttle). Diagnostics: 401 → `clerkMiddleware` public-route hint; 400 → raw-body/`verifyWebhook()` order hint; 5xx → response body inline plus the exact `clerk webhooks replay <msg_id>` line; unreachable handler → synthetic **502** framed back to the relay.
- **Verification**: deliveries failing HMAC are warned about and still forwarded (the mismatch means the relay secret diverged, not that the local handler should silently miss events).
- **Agent/`--json` mode**: NDJSON on stdout — one `ready` line (`relay_url`, `signing_secret`, `endpoint_id`, `events_filter`), then one `event` line per delivery (`svix_id`, `event_type`, `headers`, `body_b64`, `forward_status`, `latency_ms`). An event line saved to a file is directly consumable by `verify --delivery @file`.
- **SIGINT**: `listen` replaces the global cleanup-free handler before opening the socket: close socket, drain in-flight forwards, exit 130. The relay endpoint is **never** deleted on exit — its URL and `whsec_` stay stable across restarts. `listen` never exits 0.

### API endpoints

| Method  | Endpoint                        | Description                                                |
| ------- | ------------------------------- | ---------------------------------------------------------- |
| `GET`   | `/webhooks/{endpointID}`        | Reuse check for the persisted relay endpoint.              |
| `PATCH` | `/webhooks/{endpointID}`        | Re-point URL after token rotation / update `filter_types`. |
| `POST`  | `/webhooks`                     | Create the relay endpoint on first run (or after a 404).   |
| `GET`   | `/webhooks/{endpointID}/secret` | Fetch the relay endpoint's signing secret at startup.      |
