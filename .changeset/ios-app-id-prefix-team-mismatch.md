---
"clerk": minor
---

`clerk init` and `clerk doctor` now warn when an existing Clerk native registration's App ID Prefix differs from the Apple team the iOS or macOS app is signed by, as happens after moving the app to another team. Setup still uses the registered prefix, but passkeys and password AutoFill fail until it matches. The warning says how to fix it: look up the Bundle ID in Apple Developer, select the owning team in Xcode if needed, and copy the App ID's prefix into the registration in the Clerk Dashboard if it differs, or, for an iOS App ID that really uses a legacy prefix, pass `--app-id-prefix` with that prefix to confirm it. `clerk doctor` now accepts `--app-id-prefix` for that, and its production check no longer treats a mismatched prefix as confirmed. `clerk init --json` reports the warning in `identity.warnings` and as an `app-id-prefix-review` item in `handoff.remaining`; `clerk doctor` reports it as an `App ID Prefix` check.
