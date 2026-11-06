---
"clerk": patch
---

A continue of `clerk migrate import` no longer counts a user it only attached identifiers to as imported. Once every pending identifier has attached, its summary lists those users under "Finished attaching" and `--json` under `result.attached`, the line that opens the continue no longer counts them among the users left alone, and the progress bar counts the continue's users as finished rather than created. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
