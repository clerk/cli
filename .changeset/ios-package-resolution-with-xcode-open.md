---
"clerk": patch
---

Setting up an iOS or macOS app while its project is open in Xcode no longer reports a Swift package failure when Xcode starts resolving the newly added Clerk package at the same time. Setup waits for Xcode to finish, and if it still hasn't, says Xcode is resolving the packages itself instead of pointing to network access.
