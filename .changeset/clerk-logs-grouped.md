---
"clerk": minor
---

Add `--grouped` to `clerk logs list` to show each sign-in and sign-up flow as one row, with its status, its subject and its events below it, next to the logs outside any flow. Narrow it with `--group-type sign_in|sign_up` and `--status completed|failed` (both repeatable). Event filters keep the flows with a matching event, the time range picks flows by when they started, and `--limit` is at most 100. With `--json` each flow is the API's `log_group` object, unchanged. `--grouped` can't be combined with `--follow`. `--follow` now prints the logs a poll already fetched before a later page's failure ends it. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
