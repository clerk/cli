# Android e2e fixture

A minimal Android application module for CLI setup tests. It is hand-authored
and is not refreshed by `fixtures.manifest.ts`.

`native-init.test.ts` verifies Native API registration, generated Gradle/Kotlin
setup, publishable-key resources, and idempotent reruns. The fixed package name
allows the dedicated development test instance to reuse one registration.
The fixture is not a standalone Android build; a build smoke test needs root
Gradle plugin/repository configuration and an Android SDK.
