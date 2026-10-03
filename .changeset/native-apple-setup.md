---
"clerk": minor
---

Set up iOS and macOS apps with `clerk init`. Once init has linked a Clerk application, it links the Clerk Swift packages, configures capabilities, registers the native app, and optionally enables native Sign in with Apple, for both classic and JSON Xcode projects. Unchanged SwiftUI starters are initialized directly. New flags: `--dry-run` and `--json` (iOS only for now), `--xcode-project`, `--xcode-target`, `--xcode-configuration`, `--apple-sdk`, `--bundle-id`, `--app-id-prefix`, `--sign-in-with-apple`, and `--prebuilt-auth-ui`. `clerk doctor` adds read-only checks for Xcode projects.
