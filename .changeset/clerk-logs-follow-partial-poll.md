---
"clerk": patch
---

`clerk logs --follow` now prints the logs a poll already fetched before a later page's failure ends it, instead of dropping them. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
