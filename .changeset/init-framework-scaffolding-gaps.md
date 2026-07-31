---
"clerk": minor
---

Close the `clerk init` framework scaffolding gaps.

- Expo projects get their expo-router root layout wrapped with `<ClerkProvider>` and the secure token cache, and `clerk init --starter --framework expo` bootstraps a new Expo app.
- Express and Fastify projects get `clerkMiddleware()` / `clerkPlugin` wired into the server entry file (ESM and CommonJS), plus the request type augmentation for TypeScript Express apps.
- iOS (Swift) and Android (Kotlin) projects are now detected (via Xcode project bundles and AndroidManifest.xml) and `clerk init --framework ios|android` is accepted; init links the app, pulls API keys, and prints the exact SDK setup steps.
