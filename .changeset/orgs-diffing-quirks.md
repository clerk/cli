---
"clerk": patch
---

Run `config patch --dry-run` and `config put --dry-run` against the server when changes are detected, so validation errors are caught and the projected configuration (including any server-applied defaults) is returned before changes are committed.
