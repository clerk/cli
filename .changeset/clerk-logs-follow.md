---
"clerk": minor
---

Add `--follow` to `clerk logs` to keep printing new logs as they arrive, oldest first, after the usual backfill. It polls every 2 seconds (change it with `--interval`, at least `1s`), honors `--since`, `--from` and every filter, and looks back 10 seconds on each poll so a log that arrives late is still printed once (a log more than 5 minutes late may be missed). It's meant for live debugging; to export or sync logs, use log drains. It retries network errors, `5xx` and `429` with a warning, gives up after 5 minutes without a successful request, and exits 130 on Ctrl-C. With `--json` it prints one log per line (NDJSON). `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
