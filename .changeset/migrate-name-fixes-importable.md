---
"clerk": patch
---

`clerk migrate import` no longer suggests turning on names, usernames, or passwords when only users the checks reject carry them. The import doesn't send those users, so the setting would keep nothing. It also leaves out users no setting would let in, such as one with a bad password hash or one over the user limit. The checks still offer fixes that clear a reject, such as making a required name optional. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
