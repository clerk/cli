---
"clerk": minor
---

Add `clerk auth login --ticket` for headless sign-in with a single-use Dashboard sign-in ticket read from stdin. The transient sign-in session is revoked on every exit path, and expired, already-used, invalid, and MFA-required tickets fail with distinct error codes instead of retrying.
