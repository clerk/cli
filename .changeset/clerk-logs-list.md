---
"clerk": minor
---

Add an experimental `clerk logs` that lists an instance's Application Logs, newest first, with `--limit`, `--cursor` to continue a previous run, and `--json` output. It is hidden and refuses to run unless `CLERK_EXPERIMENTAL=logs` is set.
