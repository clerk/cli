---
"clerk": minor
---

Revoke live impersonation sessions with `clerk imp revoke <act_id> --user <user_id>`. When the actor token was already accepted (the sign-in URL was opened), the token itself can no longer be revoked — the command now falls back to finding and revoking the active session(s) your impersonation created. The "Revoke with" hint printed by `clerk imp` includes `--user` so the command works in both states.
