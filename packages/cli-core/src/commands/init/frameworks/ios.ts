import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";
import { canSetUpXcode } from "../ios/coordinator.js";

/**
 * iOS (Swift) support for `clerk init`.
 *
 * On macOS, once a Clerk application is linked, `clerk init` sets up the Xcode
 * project itself (see `ios/coordinator.ts`), so this plan only prints when an
 * agent hasn't chosen an application yet. Without Xcode, it prints the manual
 * quickstart steps and init pulls the publishable key into the env file.
 *
 * Docs: https://clerk.com/docs/ios/getting-started/quickstart
 */
export const ios: FrameworkScaffold = {
  name: "iOS (Swift)",
  dep: "ios",

  matches: (ctx) => ctx.framework.dep === "ios",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    if (!canSetUpXcode())
      return {
        actions: [],
        postInstructions: [
          "Add the Clerk iOS SDK via Swift Package Manager: https://github.com/clerk/clerk-ios (add both ClerkKit and ClerkKitUI to your target)",
          "Enable the Native API and register your iOS app (App ID Prefix + Bundle ID) on the Native Applications page: https://dashboard.clerk.com/~/native-applications",
          "In Xcode, add the Associated Domains capability with `webcredentials:<your-frontend-api-url>`",
          `Configure Clerk in your @main App struct: \`Clerk.configure(publishableKey: "<publishable key>")\` — copy CLERK_PUBLISHABLE_KEY from ${ctx.envFile} after \`clerk env pull\``,
          "Inject Clerk into the SwiftUI environment so views can read it via `@Environment(Clerk.self)`: `ContentView().environment(Clerk.shared)`",
          "On a Mac with Xcode, `clerk init` can do these steps for you.",
          "Full setup guide: https://clerk.com/docs/ios/getting-started/quickstart",
        ],
      };
    return {
      actions: [],
      postInstructions: [
        "clerk init sets up this Xcode project once it knows which Clerk application to use.",
        'Run `clerk apps list --json` and ask the user which application to use, or create one with `clerk apps create "<name>"`. If listing fails because you are not signed in, run `clerk auth login` first.',
        "Then run `clerk init --app <app_id> --json` to link it, configure the Xcode project, and register the app with Clerk.",
        "Full setup guide: https://clerk.com/docs/ios/getting-started/quickstart",
      ],
    };
  },
};
