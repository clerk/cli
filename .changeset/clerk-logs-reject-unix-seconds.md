---
"clerk": patch
---

Reject a Unix-seconds value like `1762702200` (as from `date +%s`) in `clerk logs --from` and `--to` instead of reading it as milliseconds in January 1970. The error suggests the millisecond value or an ISO 8601 timestamp. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
