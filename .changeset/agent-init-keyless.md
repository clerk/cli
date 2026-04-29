---
"clerk": patch
---

Allow `clerk init` to run in agent mode without requiring `--app`. For keyless-capable frameworks, agent init now uses keyless setup when no real Clerk app target is provided; explicit `--app` or an existing linked profile still uses the authenticated app-linking flow. Agent init no longer creates, auto-selects, or auto-links a Clerk application when no app target is provided.
