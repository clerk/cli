---
"clerk": patch
---

`clerk migrate runs <id>` no longer lists or counts a user as "Not confirmed", or keeps its error in the breakdown, once an undo of the run deleted it. Since the undo found it, `runs <id>` and the `clerk migrate runs` listing count it as created. Undo deletes a user whose create was cut off when it finds it by the run's marker. A user no undo deleted is still listed, since Clerk may hold it. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
