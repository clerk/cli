---
"clerk": patch
---

Add `.clerk/` to `.gitignore` when a later negation such as `!.clerk/keyless.json` re-includes a file under an existing `.clerk/*` pattern, so the keyless breadcrumb is never left committable.
