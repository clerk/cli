---
"clerk": minor
---

Add `clerk migrate export clerk` and `clerk migrate export supabase`, and let `clerk migrate import` take the export's run ID in place of a file and `--source`. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
