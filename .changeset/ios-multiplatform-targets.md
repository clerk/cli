---
"clerk": minor
---

Set up Xcode Multiplatform App targets for iOS and macOS in `clerk init` and `clerk doctor`.
With a Personal Team, iOS keeps passkeys and password AutoFill, and the Mac build signs without Associated Domains: init gives it its own entitlements file when it would otherwise share one with iOS, or says to do that in Xcode when it can't.
