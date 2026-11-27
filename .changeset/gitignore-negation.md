---
"clerk": patch
---

Add `.clerk/` to `.gitignore` when an existing `.clerk/*` or `.clerk/**` pattern is followed by a negation that can re-include the keyless breadcrumb, such as `!.clerk/keyless.json` or `!*.json`, so the breadcrumb is not left committable.
