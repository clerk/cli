---
"clerk": minor
---

`clerk doctor` checks an iOS or macOS app's Release build against the production instance: that Release's Bundle ID is registered there with Native API enabled, that its entitlements list the production Associated Domain, and that its `ClerkPublishableKey` Info.plist entry holds the production publishable key (an app that loads its key another way reports it as not verified). Without a production instance this is a single note. Run in an Xcode project, `clerk deploy` and `clerk deploy status` now point to `clerk doctor` for this check.
