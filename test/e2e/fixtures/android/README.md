# Android e2e fixture

A minimal, buildable Android application module shaped like Android Studio's Empty Activity
template (AGP 9.2.1, Kotlin 2.3.21 through the Compose compiler plugin alias, Gradle 9.4.1
wrapper), hand-authored and not refreshed by
`fixtures.manifest.ts`. It starts without Clerk: no SDK dependency, no `Application`
subclass, no INTERNET permission.

`native-init.test.ts` runs `clerk init` against it with a fixed signing fingerprint and
no debug keystore (`ANDROID_USER_HOME` points at an empty folder), then asserts the Gradle,
Kotlin, manifest, and `clerk.xml` edits, that a rerun changes nothing, that `clerk doctor`
has no failing check, and, where an Android SDK is available (`ANDROID_HOME` or
`ANDROID_SDK_ROOT` plus a JDK), that `./gradlew :app:assembleDebug` succeeds. Without an
SDK the build step is skipped with a message.

The registration for `com.clerk.cli.e2e` lives on the shared e2e application's development
instance and is reused across runs. The Platform API has no update endpoint for Android
registrations yet, so changing the fixture's `applicationId` or the test's fingerprint
means deleting the old registration on the Dashboard's Native Applications page first.
