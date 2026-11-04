---
"clerk": patch
---

`clerk migrate import` no longer suggests turning on names or passwords when only users the checks reject carry them. Those users aren't imported, so the setting would keep nothing. Fixes that clear a reject, such as making a required name optional, are still offered. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
