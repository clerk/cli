---
"clerk": minor
---

Add `clerk migrate runs` and `clerk migrate undo`, and let a re-run of `clerk migrate import` continue where a stopped one left off.

Every user an import creates now carries `clerkMigrateRun` (the run's ID) in its `private_metadata`, replacing any value the source had under that key. A re-run reads it to adopt a user whose create was cut off. Nothing removes it afterwards, and your backend can read it.
