---
"clerk": minor
---

Run `clerk logs schema` without an event type to list every event type the instance can read. Both outputs list the same types and differ only in detail: the human output has one section per group, headed by the group's title, with each type and its description and no payload fields (run `clerk logs schema <event-type>` for one type's fields), while `--json` (or agent mode) prints the catalog as the Backend API returns it, with every type's payload fields, so a single call covers every type and field `clerk logs list` can filter on. `clerk logs schema <event-type>` is unchanged. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
