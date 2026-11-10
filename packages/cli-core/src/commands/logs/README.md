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
clerk logs list --cursor <cursor>
clerk logs list --app app_123 --instance prod --json
```

| Option              | Description                                     |
| ------------------- | ----------------------------------------------- |
| `--limit <number>`  | Maximum logs to return, 1-500 (default 50)      |
| `--cursor <cursor>` | Continue from the cursor a previous run printed |
| `--json`            | Output as JSON (implied in agent mode)          |

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

| Method | Path       | Description                                                      |
| ------ | ---------- | ---------------------------------------------------------------- |
| `GET`  | `/v1/logs` | List logs (`view=flat`, `limit`, `starting_after`), newest first |
