---
"clerk": patch
---

Recognize native Sign in with Apple configuration in `clerk deploy` and `clerk deploy status`. Verify the registered Bundle ID and Native API settings before treating native Apple sign-in as ready, and avoid requesting unrelated Apple web credentials. Report missing or conflicting registrations with actionable guidance.

Add validated native application API helpers, idempotent registration requests, and conditional configuration updates. Allow application metadata reads without secret keys and share concurrent OAuth token refreshes.
