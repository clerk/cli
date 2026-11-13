---
"clerk": patch
---

When `clerk init` adds Associated Domains or Sign in with Apple to an iOS or macOS app that has no entitlements file, it now creates the file inside the app's synchronized folder (for example `MyApp/MyApp.entitlements`), as Xcode does, instead of next to the `.xcodeproj`, where Xcode's navigator didn't show it. This covers apps from Xcode 16 and later templates, `project.xcproj` projects, and `clerk init --starter` apps. Projects without a synchronized folder still get the file next to the `.xcodeproj`.
