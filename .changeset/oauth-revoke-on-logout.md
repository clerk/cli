---
"clerk": patch
---

Revoke the OAuth session with Clerk when signing out, so `clerk auth logout` ends the session everywhere instead of only deleting the local credentials. Re-authenticating over an existing session now revokes the previous one as well.
