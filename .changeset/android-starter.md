---
"clerk": minor
---

`clerk init --starter` now creates an Android app: "Android (Jetpack Compose)" in the picker, or `--framework android` with `--name` and `--android-package`. It writes a project shaped like Android Studio's Empty Activity template (AGP 9.2.1, Kotlin 2.3.21, a Compose BOM, `minSdk` 24, an initial Git commit, and the embedded Gradle 9.4.1 wrapper), then runs the Android setup on it with the UI artifact by default, and with `--prebuilt-auth-ui` (or a yes to the prompt) replaces `MainActivity` with Clerk's prebuilt sign-in screen. `--json` reports `input-required`, `application-required`, and `setup-interrupted` with the new app's continuation, as for the Apple starters.
