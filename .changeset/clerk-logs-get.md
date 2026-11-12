---
"clerk": minor
---

Add `clerk logs get <id>` to show the logs of one sign-in (`sia_…`) or sign-up (`sua_…`), oldest first, under a header with the flow's type, start and subject. It takes the same event filters as `clerk logs list`, `--limit` (up to 500) and `--cursor` to page forward, and `--json` for a `{ data, cursor }` envelope. An unknown ID fails with `log_group_not_found`; looking up a single log by its ID isn't supported yet. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
