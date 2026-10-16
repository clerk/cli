---
"clerk": minor
---

`clerk doctor` checks an iOS or macOS app's Release build against the production instance: that Release's Bundle ID is registered there with Native API enabled, that its entitlements list the production Associated Domain, and that it configures Clerk with the production publishable key when the key is loaded in a way that can be read without building (otherwise it reports the key as not verified). Without a production instance this is a single note. Run in an Xcode project, `clerk deploy` and `clerk deploy status` now point to `clerk doctor` for this check.
