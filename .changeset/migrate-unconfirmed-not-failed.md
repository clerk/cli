---
"clerk": patch
---

`clerk migrate import` no longer counts a user whose create got no answer (a 5xx or a network error) as failed. Clerk may hold that user, so the summary lists it under "Not confirmed" and `--json` under `result.unconfirmed`, matching `clerk migrate runs <id>`. The import still exits 1, and a continue checks for the user. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
