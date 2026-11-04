---
"clerk": patch
---

`clerk migrate runs <id>` no longer lists a user as "Not confirmed" once an undo of the run deleted it. Undo deletes a user whose create was cut off when it finds it by the run's marker. A user no undo deleted is still listed, since Clerk may hold it. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
