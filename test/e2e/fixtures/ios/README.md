# iOS e2e fixture

Bare Xcode project markers, hand-authored (not in `fixtures.manifest.ts` — the
refresh script never touches this directory). `clerk init` on iOS writes no
project files: it detects the platform via the `*.xcodeproj` bundle, pulls keys
into `.env`, and prints the SDK quickstart steps. `native-init.test.ts` asserts
exactly that.
