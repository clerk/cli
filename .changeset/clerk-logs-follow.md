---
"clerk": minor
---

Add `--follow` to `clerk logs` to keep printing new logs as they arrive, oldest first, after the usual backfill. It polls every 2 seconds (change it with `--interval`, at least `1s`), honors `--since`, `--from` and every filter, retries network errors, `5xx` and `429` with a warning, and stops with exit 0 on Ctrl-C. With `--json` it prints one log per line (NDJSON). `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
