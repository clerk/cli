# `clerk logs`

> **Experimental.** `clerk logs` is hidden from help and completion, and
> refuses to run (exit 2, `experiment_disabled`), unless `CLERK_EXPERIMENTAL`
> includes `logs`:
>
> ```sh
> CLERK_EXPERIMENTAL=logs clerk logs list --help
> ```
>
> `CLERK_EXPERIMENTAL` is a comma-separated list. Names are trimmed and
> case-insensitive, and unknown names are ignored.

Read an instance's [Application Logs](https://clerk.com/docs/guides/dashboard/logs/application-logs) from the Backend API: sign-ins, sign-ups, user and session changes, and the rest of the events Clerk records for the instance.

## Shared targeting and auth

Every `clerk logs` command accepts the same targeting flags as `clerk users`:

| Flag               | Description                                                   |
| ------------------ | ------------------------------------------------------------- |
| `--secret-key <k>` | Use a specific Backend API secret key directly                |
| `--app <id>`       | Target an application directly, even outside a linked project |
| `--instance <id>`  | Target `dev`, `prod`, or a full instance ID                   |

The secret key is resolved in the same order as `clerk users`: `--secret-key`, then `--app` (through Platform API auth), then `CLERK_SECRET_KEY` or the project's keyless key, then the linked project. Any instance secret key can read its logs; no Platform API scope is needed.

Every request sends `Clerk-API-Version: 2026-08-20`, the Backend API version whose logs response shape the CLI is written against.

## Commands

### `clerk logs list`

List logs, newest first, or with `--follow`, keep printing new logs as they arrive. `list` is the default subcommand, so `clerk logs` on its own does the same.

```sh
clerk logs
clerk logs list --limit 200
clerk logs --since 1h
clerk logs --from 2026-11-01 --to 2026-11-02T12:00
clerk logs --type 'sign_in.*' --user user_123
clerk logs --type user.created --fields email_address,username
clerk logs list --cursor <cursor>
clerk logs --grouped
clerk logs --grouped --group-type sign_in --status failed
clerk logs list --app app_123 --instance prod --json
clerk logs --follow
clerk logs --follow --type 'sign_in.*' --json
```

| Option                  | Description                                                                          |
| ----------------------- | ------------------------------------------------------------------------------------ |
| `--limit <number>`      | Maximum logs to return, 1-500 (default 50; at most 100 with `--grouped`)             |
| `--cursor <cursor>`     | Continue from the cursor a previous run printed                                      |
| `--since <duration>`    | Only logs from the last duration                                                     |
| `--from <timestamp>`    | Only logs at or after a time                                                         |
| `--to <timestamp>`      | Only logs at or before a time                                                        |
| Filter flags            | See [Filters](#filters)                                                              |
| `--grouped`             | One row per sign-in or sign-up flow; see [Grouped](#grouped)                         |
| `--group-type <type>`   | With `--grouped`, only flows of a type (`sign_in`, `sign_up`); repeatable            |
| `--status <status>`     | With `--grouped`, only flows that ended this way (`completed`, `failed`); repeatable |
| `--follow`              | Keep running and print new logs as they arrive; see [Follow](#follow)                |
| `--interval <duration>` | How often `--follow` polls, at least `1s` (default `2s`)                             |
| `--json`                | Output as JSON (implied in agent mode); NDJSON with `--follow`                       |

#### Time range

- `--since <duration>`: a number followed by `s`, `m`, `h`, `d` or `w`, combinable (`30m`, `2h`, `7d`, `1h30m`). Sent as `event_time_after = now - duration`.
- `--from <timestamp>` / `--to <timestamp>`: sent as `event_time_after` / `event_time_before`, both inclusive. A timestamp is an ISO 8601 date-time (`2026-11-09T15:30:00Z`, `2026-11-09T10:30:00-05:00`; read as UTC when it has no offset, so a command means the same on any machine), a date (`2026-11-09`, midnight UTC) or Unix milliseconds (`1762702200000`). A bare number before 2020 is a usage error, since it's most likely Unix seconds or a typo.
- `--since` and `--from` can't be combined; `--to` works with either. A range that starts after `--to` is a usage error, raised before any request.
- Without a time flag the API returns the newest logs within the plan's retention. It also raises a start older than the retention floor to the floor, which the retention warning reports.

#### Filters

Each filter flag is sent as a `GET /v1/logs` query parameter on every request of a run, like the time range. By default a log must match every filter; `--match any` keeps logs that match at least one of the string and `--payload-filter` filters (the time range and `--end-user-only` always apply).

| Flag                            | API parameter                  | Notes                                                                   |
| ------------------------------- | ------------------------------ | ----------------------------------------------------------------------- |
| `--type <type>`                 | `type`                         | An event type, or a prefix with a trailing `*` (`sign_in.*`)            |
| `--user <user-id>`              | `user_id`                      | Logs where the user is the actor or the subject                         |
| `--identifier <value>`          | `identifier`                   | An email address, phone number, username or web3 wallet; exact match    |
| `--actor <id>`                  | `actor`                        |                                                                         |
| `--subject <id>`                | `subject`                      |                                                                         |
| `--session <id>`                | `session_id`                   | The session that made the request, not one a `session.*` event is about |
| `--client <id>`                 | `client_id`                    |                                                                         |
| `--ip <address>`                | `ip_address`                   |                                                                         |
| `--trace <id>`                  | `trace_id`                     |                                                                         |
| `--impersonator <user-id>`      | `impersonator_user_id`         |                                                                         |
| `--payload-filter <path=value>` | `payload_filter[<path>]=value` | Repeatable; a payload field (dot path) equals a value. Needs `--type`   |
| `--fields <a,b>`                | `payload_fields`               | Payload fields to return in each log's `payload`. Needs `--type`        |
| `--match <all\|any>`            | `filter_match`                 | `all` (default) sends nothing                                           |
| `--end-user-only`               | `end_user_facing_only=true`    | Only event types shown to end users                                     |

These combinations are usage errors, raised before any request, matching the Backend API's own checks:

- `--user` with `--identifier`, `--actor` or `--subject`; `--identifier` with `--actor` or `--subject`.
- `--user` that isn't a user ID (`user_…`), or `--identifier` that is one.
- `--type` with a `*` anywhere but the end, or more than one.
- `--payload-filter` or `--fields` without `--type`, and `--fields` with `--match any`.
- An empty value for any string filter flag (`--user ""`, as from an unset shell variable), since the API would treat it as no filter and list every log.
- A `--payload-filter` without `=` or with an empty path or value, and a payload path with an empty segment (`a..b`).

The API's own limits on payload paths (how many, how deep, how long a value) and whether a path exists for the type are left to the API: a path it rejects fails with its error, which lists the allowed paths for the type.

With `--fields`, the table gets a `PAYLOAD` column with the returned fields as `path=value` pairs. JSON output passes each log's `payload` through as the API returns it.

#### Paging

The API scans one time window per request, sized from the instance's event rate, so a page can come back short or even empty while older logs remain (`next_page_status: "unknown"`). The command keeps requesting pages until it has `--limit` logs or the API reports there are no more, up to 50 requests per run; past that it returns what it has and the cursor to continue from. An empty window never reads as "no logs". If a request fails after some logs were already fetched, the command still prints them, with `cursor.next` set to the page that failed, warns that listing stopped early, and exits with the error; `--cursor <next>` retries that page.

Human output is a table (`TIME`, `TYPE`, `ACTOR`, `SUBJECT`, `LOCATION`, `LOG ID`) with times in local time, followed by the count, the time range searched and, when more logs are available, the `--cursor` to continue from. When the search reached the plan's log retention window, a warning says how far back results go.

JSON output:

```json
{
  "data": [
    { "object": "log", "id": "…", "event_time": 1731166000123, "type": "user.created", "…": "…" }
  ],
  "cursor": {
    "next": "…",
    "retention_limit_reached": false,
    "retention_days": 7,
    "searched_from": 1731079600000,
    "searched_to": 1731166300000
  }
}
```

- `data`: the log objects exactly as the Backend API returns them.
- `cursor.next`: pass to `--cursor` for older logs; `null` when there are none.
- `cursor.retention_limit_reached`: the search reached the plan's log retention window (`retention_days`); nothing older can be listed.
- `cursor.searched_from` / `cursor.searched_to`: the time range searched, in Unix milliseconds.

#### Grouped

`--grouped` requests the grouped view (`view=grouped`) instead of the flat one (`view=flat`, the CLI's default even though the API defaults to grouped). Each sign-in and sign-up flow is one `log_group` item, with its first events, next to the logs that belong to no flow ([log groups](https://clerk.com/docs/guides/dashboard/logs/application-logs#log-groups)). Items are newest first: a group sorts by when it started, a log by its `event_time`.

- `--group-type <sign_in|sign_up>` and `--status <completed|failed>` are sent as `group_type` and `status`, once per value (repeat the flag for several; a value given twice is sent once). Either one keeps only groups, so the logs outside any flow are left out. Both require `--grouped` (usage errors, exit 2, otherwise, since the API rejects them on the flat view). A flow that hasn't concluded has no status, so `--status` never matches it.
- `--limit` is at most 100 with `--grouped`: every group brings up to 50 events along, and the API rejects more. It counts items (groups and ungrouped logs), not events.
- The event filters and the time range still apply. An event filter keeps the groups with at least one matching event, and each group lists only its matching events. The time range selects groups by when they started, and each group's events run to the end of the flow.
- Paging works as in the flat list (`next_page_status`, up to 50 requests a run), but the grouped view only pages forward. `--cursor` still maps to `starting_after`; a grouped cursor and a flat cursor aren't interchangeable, and the API rejects one passed to the other view.
- `--grouped` can't be combined with `--follow` (usage error): a group summarizes a flow that may still be going, which has no meaning for a stream.

Human output is one row per group, `STARTED`, `TYPE` (the flow's `group_type`, `sign_in` or `sign_up` today, so a new kind of flow shows up here without a new column), `GROUP` (the flow's ID, `sia_…` or `sua_…`), `STATUS` (green `completed`, red `failed`, empty while the flow hasn't concluded), `SUBJECT` (who the flow is about) and `EVENTS` (`event_count`, or `<matched> of <total>` under event filters), with the group's events indented two spaces below it in the usual log columns (and `PAYLOAD` with `--fields`). A log outside any flow gets a row of its own, with `-` for `TYPE` and `GROUP`, and itself below. When the API left some of a group's events out (`has_more_events`), a dim note below them says so and names `clerk logs get <group_id>` to read the rest: `N more matching events not shown` under event filters, where the count is exact, and `more events not shown` otherwise, since `event_count` can include event types the instance can't read. The summary counts groups and the logs outside a group.

```text
STARTED   TYPE     GROUP     STATUS     SUBJECT    EVENTS
15:30:00  sign_in  sia_2ab…  completed  user_2ab…  3
  15:30:00  sign_in.created    user_2ab…  user_2ab…  Lima, PE  log_2xa…
  15:30:04  sign_in.completed  user_2ab…  user_2ab…  Lima, PE  log_2xb…
  15:30:04  session.created    user_2ab…  user_2ab…  Lima, PE  log_2xc…
15:29:10  -        -                    user_2ab…  1
  15:29:10  user.updated       user_2ab…  user_2ab…  Lima, PE  log_2xd…
```

JSON output is the same `{ data, cursor }` envelope, with each item exactly as the API returns it: a `log_group` (`group_id`, `group_type`, `started_at`, `event_count`, `matched_event_count` under event filters, `status`, `status_label`, `subject`, `first_event`, `events`, `has_more_events`, `events_cursor`) or a `log`. Tell them apart by `object`.

#### Follow

`--follow` prints the same backfill `list` would (the newest `--limit` logs, honoring `--since`/`--from` and every filter), then keeps running and polls for new logs every `--interval` (default `2s`, at least `1s`; same duration format as `--since`) until Ctrl-C.

`--follow` is for live debugging; to export or sync logs, use [log drains](https://clerk.com/docs/guides/dashboard/logs/application-logs#export-logs).

- Output is chronological, oldest first, including the backfill (unlike `list`, which is newest first), with one exception: a late log.
- Logs reach the API through a pipeline, so a log can arrive after a newer one was printed. Each poll looks back 10 seconds: it sends `event_time_after = <event_time of the newest log printed> - 10s` with the same filters, at the API's maximum page size, and skips the logs it already printed by log ID. A log that arrives up to 10 seconds late is printed when it arrives, after logs newer than it; one later than that is missed. Only the IDs of logs inside the window are remembered, so memory doesn't grow over a long follow.
- The lookback never reaches more than 5 minutes before the API's clock, read from the latest response's `Date` header (the local clock, read before the request, if the header is missing). After a quiet stretch, each poll scans at most those 5 minutes instead of everything since the last log printed, so a log that takes more than 5 minutes to become visible in the API may be missed. The bound may be tuned once the pipeline's arrival delay is measured.
- Before any log is printed, the window ends at the API's clock when the backfill ran, read from the first response's `Date` header (the local clock, read before the request, if the header is missing). Not at the backfill's `searched_to`: a first page searches up to 5 minutes past the API's clock, so anchoring there would skip the logs of those minutes. It never reaches back past `--since`/`--from`, or, when `--limit` cut the backfill short, past the oldest log the backfill printed.
- A poll keeps paging while `next_page_status` is `"unknown"` (or `"true"`), up to 50 requests. A poll that hits that cap (a backlog after an outage) prints what it fetched and the next poll picks up where it stopped, right away and before looking for newer logs, so nothing is skipped; those older logs print after the newer ones.
- `--limit` bounds only the backfill. `--follow` can't be combined with `--to` (new logs are always later), `--cursor` or `--grouped` (usage errors, exit 2); `--interval` without `--follow` is a usage error too.
- Transient failures (network errors, `5xx`, `429`) are retried with a warning on stderr: the backoff starts at 1s and doubles per attempt up to 30s, or waits a `429`'s `Retry-After` (also capped at 30s). After 5 minutes of failures with no successful request in between, the follow gives up and exits with the last error; any successful request restarts the 5 minutes. A request that gets no answer within 30 seconds is abandoned and retried the same way, so a connection that stops responding can't hang the follow. Any other API error, including `401` and `403`, exits with that error at once.
- Ctrl-C stops the follow and exits 130 (by SIGINT), like `clerk webhooks listen` and any other interrupted operation, so `clerk logs --follow && next-step` doesn't run `next-step`. It cancels the poll wait or the request in flight; logs from pages already fetched are printed first.
- With `--json` (or in agent mode) the output is NDJSON: one log object per line on stdout, written as each log arrives, exactly as the Backend API returns it. There's no `{ data, cursor }` envelope.
- Human output is one line per log on stderr, under a header printed once. A stream can't size columns from rows it hasn't seen, so each column has a fixed minimum width: `TIME` 8, `TYPE` 28, `ACTOR` and `SUBJECT` 32 (a Clerk ID), `LOCATION` 20, then `LOG ID`. A longer value pushes the rest of its line right rather than being cut. With `--fields`, `PAYLOAD` comes last, after `LOG ID`, since it has no natural width.

```text
TIME      TYPE                          ACTOR                             SUBJECT                           LOCATION              LOG ID
15:30:00  user.created                  user_2abc…                        user_2abc…                        Lima, PE              log_2xyz…
```

### `clerk logs get <id>`

Show the logs of one log group, oldest first. A log group is one flow: a sign-in (`sia_…`) or a sign-up (`sua_…`), and the flow's ID is the group's ID.

```sh
clerk logs get sia_123
clerk logs get sua_123 --json
clerk logs get sia_123 --type 'sign_in.*'
clerk logs get sia_123 --cursor <cursor>
clerk logs get sia_123 --app app_123 --instance prod
```

| Option              | Description                                     |
| ------------------- | ----------------------------------------------- |
| `--limit <number>`  | Maximum logs to return, 1-500 (default 50)      |
| `--cursor <cursor>` | Continue from the cursor a previous run printed |
| Filter flags        | The same as `list`; see [Filters](#filters)     |
| `--json`            | Output as JSON (implied in agent mode)          |

- The ID is checked before any request. A sign-in or sign-up ID reads the group's logs. A log ID (a UUID) is a usage error for now, since looking up a single log by its ID isn't supported yet; anything else is a usage error that lists the accepted forms.
- The request sends no `started_at`: the Backend API looks the group's start up from its ID. A group it can't find in the targeted instance (an unknown ID, another instance's group, one that started a few seconds ago and hasn't reached the logs store yet, or one entirely past the plan's log retention) fails with `log_group_not_found`, naming the instance the request went to.
- The event filters work as in `list` and are checked the same way. `get` has no time range flags, `--follow`, or group filters: the group is already chosen, and the endpoint picks a group's logs by when the group started, not by each log's time.
- The endpoint returns full pages (it doesn't scan time windows like `GET /v1/logs`), so one request covers `--limit`. When the group has more logs, `cursor.next` is set; pass it to `--cursor` to page forward. Only forward paging is supported.

Human output is a header with the group type and ID, then when the group started and, when the page holds all of the group's logs (no `--cursor`, no event filter, and nothing left to page), its subject (the latest user any of its logs is about, or the first log's subject when none is), the same table as `list`, and the count with the `--cursor` to continue from when there are more logs. The endpoint doesn't return the group's status, so the header leaves it out.

```text
sign_up sua_2xYzAbC123
Started 15:56:21 · Subject user_2def

TIME      TYPE                            ACTOR  SUBJECT    LOCATION  LOG ID
15:56:21  sign_up.created                 -      ins_2abc   Lima, PE  019d8e31-a1bc-…
15:56:25  sign_up.verification_attempted  -      ins_2abc   Lima, PE  019d8e31-b2cd-…
15:56:27  sign_up.completed               -      user_2def  Lima, PE  019d8e31-c3de-…

3 logs · more: re-run with `--cursor <cursor>`
```

JSON output has the same `{ data, cursor }` shape as `list`. `cursor` carries only `next`, since the endpoint doesn't search a time window or report retention:

```json
{
  "data": [
    { "object": "log", "id": "…", "type": "sign_up.created", "group_id": "sua_…", "…": "…" }
  ],
  "cursor": { "next": null }
}
```

### `clerk logs schema [event-type]`

Without an argument, list every event type the instance can read. With one, show the payload fields of an event type: the dot-paths, their types, whether each is optional, and the accepted values of enum fields.

```sh
clerk logs schema
clerk logs schema --json
clerk logs schema sign_in.completed
clerk logs schema 'sign_in.*'
clerk logs schema sign_in
clerk logs schema user.created --json
```

| Option   | Description                            |
| -------- | -------------------------------------- |
| `--json` | Output as JSON (implied in agent mode) |

#### Every event type

`clerk logs schema` with no argument reads `GET /v1/logs/types`: one entry per event type the instance can read, each with its payload schema. Event types whose logs are enabled per instance (such as `sms.*` and `email.*`) are listed only once enabled. The list isn't paginated.

Human output is a table (`TYPE`, `GROUP`, `DESCRIPTION`) sorted by docs group, then by type, so a family's types sit together (a type without a group goes last), followed by the count and a hint to run `clerk logs schema <event-type>` for a type's fields. The table leaves the fields out.

```text
TYPE               GROUP    DESCRIPTION
session.created    session  A session was created.
session.ended      session  A session ended.
sign_in.completed  sign_in  A user completed a sign-in.
sign_in.failed     sign_in  A sign-in attempt failed.
user.created       user     A user was created.

5 event types
→ See a type's fields: clerk logs schema <event-type>
```

JSON output is the list exactly as the Backend API returns it, sorted by `event_type`, with every type's `fields`: the one call that shows everything `clerk logs list --type`, `--payload-filter` and `--fields` can query. Each entry has the same shape as the single-type output below.

```json
{
  "object": "list",
  "data": [
    {
      "object": "log_schema",
      "event_type": "sign_in.completed",
      "description": "A user completed a sign-in.",
      "severity": "success",
      "docs_group": "sign_in",
      "fields": [{ "path": "sign_in_id", "type": "string", "optional": false }]
    }
  ],
  "total_count": 1
}
```

A response without a `data` array, or with an entry that isn't an object, fails with "The Logs API returned an unexpected response." in both modes. A `404` means the Backend API the CLI reached doesn't have `GET /v1/logs/types` yet (an older deployment, or a `CLERK_BACKEND_API_URL` override pointing at one), since the route has nothing else to not find; it fails with an error saying the API can't list event types yet and to pass an event type instead.

#### One event type

The event type is passed to `GET /v1/logs/schemas` as-is. It can be:

- a concrete type, like `sign_in.completed`;
- a trailing-`*` wildcard, like `sign_in.*` (quote it so the shell doesn't expand it);
- a bare family name, like `sign_in`, which the API reads as `sign_in.*` when no concrete type has that name.

For a wildcard or family, the fields are only the ones every matched type shares, and `matched_event_types` lists those types. An empty event type (`clerk logs schema ""`, as from an unset shell variable) or a bare `*` is a usage error raised before any request, rather than a listing of every type. An unknown event type, or one the instance can't read (such as SMS or email types behind a feature gate), fails with the API's 422 error.

Human output is a header with the event type, its description and severity (or, for a wildcard, the matched event types), then a table (`PATH`, `TYPE`, `OPTIONAL`, `ENUM`), and a hint showing how to filter logs on the first field.

JSON output is the `log_schema` object exactly as the Backend API returns it:

```json
{
  "object": "log_schema",
  "event_type": "sign_in.*",
  "matched_event_types": ["sign_in.completed", "sign_in.failed"],
  "fields": [{ "path": "sign_in_id", "type": "string", "optional": false }]
}
```

`fields[].type` is `string`, `boolean`, `integer` or `number`; enum-backed fields are `string` with an `enum` list. `description`, `severity` and `docs_group` are present only for a concrete type.

## API endpoints

| Method | Path                                | Description                                                                                                                                                                                                                                                                                                                                                                       |
| ------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/logs`                          | List logs (`view=flat`, or `view=grouped` with `group_type` and `status`; `limit`, `starting_after`, `event_time_after`, `event_time_before`, `type`, `user_id`, `identifier`, `actor`, `subject`, `session_id`, `client_id`, `ip_address`, `trace_id`, `impersonator_user_id`, `payload_filter[<path>]`, `payload_fields`, `filter_match`, `end_user_facing_only`), newest first |
| `GET`  | `/v1/logs/groups/{group_id}/events` | A log group's logs, oldest first (`limit`, `starting_after` and the list's event filters; no `started_at`)                                                                                                                                                                                                                                                                        |
| `GET`  | `/v1/logs/types`                    | Every event type the instance can read, each with its payload schema (not paginated)                                                                                                                                                                                                                                                                                              |
| `GET`  | `/v1/logs/schemas`                  | Payload schema of an event type (`type`)                                                                                                                                                                                                                                                                                                                                          |
