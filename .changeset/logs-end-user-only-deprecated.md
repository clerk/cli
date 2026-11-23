---
"clerk": patch
---

Deprecate `--end-user-only` on `clerk logs list` and `clerk logs get`. The Backend API now ignores it, so it filters nothing. Passing it still works and prints a warning.
