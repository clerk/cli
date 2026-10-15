---
"clerk": patch
---

Recognize native-only Sign in with Apple in `clerk deploy` and `clerk deploy status`. Apple counts as configured once its production Bundle ID registration and Native API are ready; until then deploy offers Apple web credentials or pauses with a link to the production Native Applications page. Doctor recognizes Platform API keys and verifies account access through the Clerk API when OAuth userinfo rejects a valid session. Concurrent OAuth token refreshes in one process now share a single refresh.
