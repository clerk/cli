---
"clerk": patch
---

`clerk migrate import` now warns about users it created without an email or phone Clerk refused, in the summary, `--json`, and `clerk migrate runs <id>`. A mistyped secret key gets Clerk's invalid-key error. A refused dry run says so and prints the `--allow-partial` command. A gateway's HTML error page no longer fills the error breakdown. The checks explain how to replace `APP_ID` in fix commands, and `--json` carries the notes the summary prints. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
