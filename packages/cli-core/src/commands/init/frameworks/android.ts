import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

export const ANDROID_QUICKSTART = "https://clerk.com/docs/android/getting-started/quickstart";

/**
 * The manual steps, for a project whose layout native setup refused: init links the app and
 * pulls the publishable key into the env file, and the developer does the rest by hand.
 */
export function androidManualSteps(envFile: string): string[] {
  return [
    'Add the Clerk Android SDK to your application module: `implementation("com.clerk:clerk-android-api:<latest-version>")` (or `clerk-android-ui` plus `androidx.lifecycle:lifecycle-viewmodel-compose`); requires minSdk 24+, Kotlin 2.3+, and Java 17+. Latest version: https://github.com/clerk/clerk-android/releases',
    "Enable the Native API and register your app's applicationId with the SHA-256 fingerprint of its signing certificate (`./gradlew signingReport`) on the Native Applications page: https://dashboard.clerk.com/~/native-applications",
    'Add `<uses-permission android:name="android.permission.INTERNET"/>` to AndroidManifest.xml and register an Application subclass via `android:name`',
    `Initialize Clerk in your Application subclass: \`Clerk.initialize(this, publishableKey = "<publishable key>")\` — copy CLERK_PUBLISHABLE_KEY from ${envFile} after \`clerk env pull\``,
    `Full setup guide: ${ANDROID_QUICKSTART}`,
  ];
}

/**
 * Android (Kotlin) support for `clerk init`.
 *
 * Once a Clerk application is linked, `clerk init` sets up the Gradle module itself (see
 * `android/coordinator.ts`), so this plan prints only when an agent hasn't chosen an application
 * yet, or when native setup refused the project's layout: then init prints the manual quickstart
 * steps and pulls the publishable key into the env file, as it did before native setup.
 *
 * Docs: https://clerk.com/docs/android/getting-started/quickstart
 */
export const android: FrameworkScaffold = {
  name: "Android (Kotlin)",
  dep: "android",

  matches: (ctx) => ctx.framework.dep === "android",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    if (ctx.nativeFallback)
      return {
        actions: [],
        postInstructions: [
          `clerk init couldn't set up this module itself: ${ctx.nativeFallback}`,
          ...androidManualSteps(ctx.envFile),
        ],
      };
    return {
      actions: [],
      postInstructions: [
        "clerk init sets up this Android project once it knows which Clerk application to use.",
        'Run `clerk apps list --json` and ask the user which application to use, or create one with `clerk apps create "<name>"`. If listing fails because you are not signed in, run `clerk auth login` first.',
        `Then run \`${ctx.nativeContinuation ?? "clerk init --app <app_id> --json"}\` to link it, configure the Gradle module, and register the app with Clerk.`,
        `Full setup guide: ${ANDROID_QUICKSTART}`,
      ],
    };
  },
};
