---
"clerk": patch
---

`clerk init` and `clerk doctor` now warn when an existing Clerk native registration's App ID Prefix differs from the Apple team the iOS or macOS app is signed by, as happens after moving the app to another team. Setup still uses the registered prefix, but passkeys and native Sign in with Apple fail until it matches. The warning says how to fix it: edit the registration's prefix in the Clerk Dashboard, or, for an iOS App ID that really uses a legacy prefix, pass `--app-id-prefix` with that prefix to confirm it. In `--json` output it appears in `identity.warnings` and as an `app-id-prefix-review` item in `handoff.remaining`.
