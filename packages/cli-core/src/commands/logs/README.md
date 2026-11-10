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

List logs, newest first. `list` is the default subcommand, so `clerk logs` on its own does the same.

```sh
clerk logs
clerk logs list --limit 200
clerk logs --since 1h
clerk logs --from 2026-11-01 --to 2026-11-02T12:00
clerk logs --type 'sign_in.*' --user user_123
clerk logs --type user.created --fields email_address,username
clerk logs list --cursor <cursor>
clerk logs list --app app_123 --instance prod --json
```

| Option               | Description                                     |
| -------------------- | ----------------------------------------------- |
| `--limit <number>`   | Maximum logs to return, 1-500 (default 50)      |
| `--cursor <cursor>`  | Continue from the cursor a previous run printed |
| `--since <duration>` | Only logs from the last duration                |
| `--from <timestamp>` | Only logs at or after a time                    |
| `--to <timestamp>`   | Only logs at or before a time                   |
| Filter flags         | See [Filters](#filters)                         |
| `--json`             | Output as JSON (implied in agent mode)          |

#### Time range

- `--since <duration>`: a number followed by `s`, `m`, `h`, `d` or `w`, combinable (`30m`, `2h`, `7d`, `1h30m`). Sent as `event_time_after = now - duration`.
- `--from <timestamp>` / `--to <timestamp>`: sent as `event_time_after` / `event_time_before`, both inclusive. A timestamp is an ISO 8601 date-time (`2026-11-09T15:30:00Z`, `2026-11-09T10:30:00-05:00`; read as UTC when it has no offset, so a command means the same on any machine), a date (`2026-11-09`, midnight UTC) or Unix milliseconds.
- `--since` and `--from` can't be combined; `--to` works with either. A range that starts after `--to` is a usage error, raised before any request.
- Without a time flag the API returns the newest logs within the plan's retention. It also raises a start older than the retention floor to the floor, which the retention warning reports.

#### Filters

Each filter flag is sent as a `GET /v1/logs` query parameter on every request of a run, like the time range. By default a log must match every filter; `--match any` keeps logs that match at least one of the string filters (the time range and `--end-user-only` always apply).

| Flag                            | API parameter                  | Notes                                                                 |
| ------------------------------- | ------------------------------ | --------------------------------------------------------------------- |
| `--type <type>`                 | `type`                         | An event type, or a prefix with a trailing `*` (`sign_in.*`)          |
| `--user <user-id>`              | `user_id`                      | Logs where the user is the actor or the subject                       |
| `--identifier <value>`          | `identifier`                   | An email address, phone number, username or web3 wallet; exact match  |
| `--actor <id>`                  | `actor`                        |                                                                       |
| `--subject <id>`                | `subject`                      |                                                                       |
| `--session <id>`                | `session_id`                   |                                                                       |
| `--client <id>`                 | `client_id`                    |                                                                       |
| `--ip <address>`                | `ip_address`                   |                                                                       |
| `--trace <id>`                  | `trace_id`                     |                                                                       |
| `--impersonator <user-id>`      | `impersonator_user_id`         |                                                                       |
| `--payload-filter <path=value>` | `payload_filter[<path>]=value` | Repeatable; a payload field (dot path) equals a value. Needs `--type` |
| `--fields <a,b>`                | `payload_fields`               | Payload fields to return in each log's `payload`. Needs `--type`      |
| `--match <all\|any>`            | `filter_match`                 | `all` (default) sends nothing                                         |
| `--end-user-only`               | `end_user_facing_only=true`    | Only event types shown to end users                                   |

These combinations are usage errors, raised before any request, matching the Backend API's own checks:

- `--user` with `--identifier`, `--actor` or `--subject`; `--identifier` with `--actor` or `--subject`.
- `--user` that isn't a user ID (`user_…`), or `--identifier` that is one.
- `--type` with a `*` anywhere but the end, or more than one.
- `--payload-filter` or `--fields` without `--type`, and `--fields` with `--match any`.
- A `--payload-filter` without `=`, with an empty path or value, or a value over 256 characters; a path more than 4 levels deep; more than 10 paths, or the same path twice, in `--payload-filter` or in `--fields`.

Whether a payload path exists for the type is left to the API: an unknown path fails with the API's error, which lists the allowed paths.

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

## API endpoints

| Method | Path       | Description                                                                                                                                                                                                                                                                                                                     |
| ------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/v1/logs` | List logs (`view=flat`, `limit`, `starting_after`, `event_time_after`, `event_time_before`, `type`, `user_id`, `identifier`, `actor`, `subject`, `session_id`, `client_id`, `ip_address`, `trace_id`, `impersonator_user_id`, `payload_filter[<path>]`, `payload_fields`, `filter_match`, `end_user_facing_only`), newest first |
