---
"clerk": patch
---

Report when signing out cannot revoke the session with Clerk, instead of always printing a clean sign-out. Local credentials are still removed either way, and `clerk auth logout` now also warns when `CLERK_PLATFORM_API_KEY` is set, since that key keeps authenticating requests.

Revoke the superseded session more reliably when re-authenticating: a transient error while checking the existing session no longer leaves the old session un-revoked, and a malformed `CLERK_OAUTH_BASE_URL` no longer aborts sign-out partway through.
