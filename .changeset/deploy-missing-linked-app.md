---
"clerk": patch
---

When the linked Clerk app was deleted or is no longer accessible, `clerk deploy` and `clerk deploy status` now say so and tell you how to re-link. Agent-mode `clerk link` checks the saved app still exists instead of reporting "Already linked".
