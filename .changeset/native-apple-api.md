---
"clerk": patch
---

Recognize native Sign in with Apple configuration in `clerk deploy` and `clerk deploy status`. Verify the registered Bundle ID and Native API settings before treating native Apple sign-in as ready. Let developers keep native-only setup or also configure Apple web credentials. Report missing or conflicting registrations with actionable guidance, including while DNS setup is pending.

Add validated native application API helpers, idempotent registration requests, and conditional configuration updates. Allow application metadata reads without secret keys and share concurrent OAuth token refreshes.

Recognize Platform API keys in Doctor's account checks and verify account access through the Clerk API when the OAuth userinfo check is unavailable for otherwise valid credentials.
