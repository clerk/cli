---
"clerk": patch
---

`clerk migrate import` now warns about users it created without an email or phone Clerk refused, in the summary, `--json`, and `clerk migrate runs <id>`, which also warns about users imported without their first phone. An attach that fails on the key or a `429` that outlasts the retries stays pending for a re-run, with a note saying why, and one Clerk calls taken counts as attached when the user already holds it. A secret key Clerk rejects gets Clerk's error and says where the key came from. A refused dry run says so and gives the same next steps as the real run. A run undone in full no longer blocks an import when Clerk can't name the instance. A gateway's HTML error page no longer fills the error breakdown. The checks explain how to replace `APP_ID` in fix commands, and `--json` carries the notes the summary prints. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
