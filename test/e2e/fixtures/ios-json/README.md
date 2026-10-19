# Xcode JSON iOS fixture

A minimal, Clerk-authored SwiftUI application using Xcode's JSON-based
`project.xcproj` project configuration format. It mirrors the source layout and
identity evidence of the classic [`../ios`](../ios) fixture so inspection and
mutation tests can compare the two formats without changing their product
scenario.

The project document's schema and formatting were verified with Xcode 27.2
beta (`27B5019j`) by converting the matching classic fixture with
`xcodebuild -convert-project xcproj`, formatting it with `xcprojformatter`, and
building the CLI-mutated project for the iOS Simulator. All names, identifiers,
settings, entitlements, and Swift sources in this fixture were authored for
Clerk; no third-party application code is included.

Keep the trailing commas in `project.xcproj`. Xcode's JSON project format
supports them even though strict JSON parsers do not.
