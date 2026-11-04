---
"clerk": patch
---

A continue of `clerk migrate import` no longer counts a user it only attached identifiers to as imported. Once nothing is left pending, its summary lists those users under "Finished attaching" and `--json` under `result.attached`, and the line that opens the continue no longer counts them among the users left alone. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
