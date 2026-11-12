---
"clerk": patch
---

Reject a bare number before 2020 in `clerk logs --from` and `--to`, like the Unix-seconds value `1762702200` from `date +%s`, instead of reading it as milliseconds in 1970. The error says the flag takes Unix milliseconds or an ISO 8601 date-time. `clerk logs` is still experimental and needs `CLERK_EXPERIMENTAL=logs`.
