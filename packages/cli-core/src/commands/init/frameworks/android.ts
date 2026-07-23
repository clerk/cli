import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

/**
 * Android (Kotlin) support for `clerk init`.
 *
 * The Clerk Android SDK ships via Gradle (`com.clerk:` artifacts) and the
 * publishable key is configured in Kotlin source (`Clerk.initialize(...)`),
 * not an env file. Gradle files are user-managed build scripts with too many
 * layout variants (Groovy/Kotlin DSL, version catalogs) to modify safely, so
 * this scaffolder prints the exact quickstart steps; `clerk init` still links
 * the app and pulls real keys so the user can copy the publishable key.
 *
 * Docs: https://clerk.com/docs/android/getting-started/quickstart
 */
export const android: FrameworkScaffold = {
  name: "Android (Kotlin)",
  dep: "android",

  matches: (ctx) => ctx.framework.dep === "android",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    return {
      actions: [],
      postInstructions: [
        'Add the Clerk Android SDK to app/build.gradle.kts: `implementation("com.clerk:clerk-android-ui:<latest-version>")` and `implementation("androidx.lifecycle:lifecycle-viewmodel-compose:2.9.2")` (requires minSdk 24+ and Java 17+; latest version: https://github.com/clerk/clerk-android/releases)',
        "Enable the Native API and register your Android app on the Native Applications page: https://dashboard.clerk.com/~/native-applications",
        'Add `<uses-permission android:name="android.permission.INTERNET"/>` to AndroidManifest.xml and register an Application subclass via `android:name`',
        `Initialize Clerk in your Application subclass: \`Clerk.initialize(this, publishableKey = "<publishable key>")\` — copy CLERK_PUBLISHABLE_KEY from ${ctx.envFile} after \`clerk env pull\``,
        "Full setup guide: https://clerk.com/docs/android/getting-started/quickstart",
      ],
    };
  },
};
