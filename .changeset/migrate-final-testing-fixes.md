---
"clerk": patch
---

Report users that `clerk migrate import` created without an email or phone Clerk refused, in the summary, `--json` and `clerk migrate runs <id>`, and fix several misleading messages: a mistyped secret key now gets Clerk's invalid-key error, a refused dry run says so, a gateway's HTML error page no longer fills the error breakdown, the `APP_ID` placeholder in fix commands is explained, and `--json` carries the same notes the human summary prints. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
