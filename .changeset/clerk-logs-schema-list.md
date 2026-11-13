---
"clerk": minor
---

Run `clerk logs schema` without an event type to list every event type the instance can read, in a `TYPE`, `GROUP` and `DESCRIPTION` table sorted by group. With `--json` (or in agent mode) it prints the whole catalog from the Backend API, with each type's payload fields, so one call shows everything `clerk logs list` can filter on. `clerk logs schema <event-type>` is unchanged. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
