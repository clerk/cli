# Android e2e fixture

Bare Android project markers, hand-authored (not in `fixtures.manifest.ts` —
the refresh script never touches this directory). `clerk init` on Android
writes no project files: it detects the platform via `AndroidManifest.xml`,
pulls keys into `.env`, and prints the SDK quickstart steps.
`native-init.test.ts` asserts exactly that.
