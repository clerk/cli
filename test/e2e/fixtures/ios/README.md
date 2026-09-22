# iOS e2e fixture

A minimal, parseable native iOS application target, hand-authored outside
`fixtures.manifest.ts` so the refresh script never replaces it. Its explicit
target sources are the pristine Xcode SwiftUI `App` and canonical
`ContentView` placeholder, making it eligible for the optional prebuilt
authentication UI without treating an in-progress application as disposable.

The native init E2E test verifies that `clerk init` links ClerkKit and
ClerkKitUI to this exact target, configures the linked development publishable
key directly in the shipping `@main` source, injects `Clerk.shared` into the
root SwiftUI view, keeps `ContentView` unchanged unless the prebuilt UI is
explicitly selected, avoids intermediate dotenv/plist files, verifies the
Native API and exact iOS registration through the Platform API, and leaves
unrelated files unchanged.
