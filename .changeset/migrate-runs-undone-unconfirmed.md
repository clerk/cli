---
"clerk": patch
---

`clerk migrate runs <id>` no longer lists or counts a user as "Not confirmed", or keeps its error in the breakdown, once an undo of the run deleted it. When undo finds a cut-off create by the run's marker, it deletes the user, so `runs <id>` and the `clerk migrate runs` listing count that user as created. Once the run is undone in full, `runs <id>` and the listing show no user as not confirmed, in the list or the counts, since undo looked for each one by the marker. After any undo, the warnings, the users left to attach and the left-to-attach count also leave out the users it deleted. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
