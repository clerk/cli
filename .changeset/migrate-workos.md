---
"clerk": minor
---

Add `clerk migrate export workos`, and let `clerk migrate import` read WorkOS exports. WorkOS returns no password hashes, so imported users reset their password or sign in with SSO. `clerk init` now also flags a WorkOS install and links the migration guide. `clerk migrate` is still experimental and needs `CLERK_EXPERIMENTAL=migrate`.
