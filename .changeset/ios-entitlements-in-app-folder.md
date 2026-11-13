---
"clerk": patch
---

Create the entitlements file inside the app's synchronized folder (for example `MyApp/MyApp.entitlements`), as Xcode does, when `clerk init` adds Associated Domains or Sign in with Apple to an iOS or macOS app that has none, so Xcode's navigator shows it. This covers apps from Xcode 16 and later templates, `project.xcproj` projects, and `clerk init --starter` apps; projects without a synchronized folder still get the file next to the `.xcodeproj`.
