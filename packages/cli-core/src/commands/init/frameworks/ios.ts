import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";

/**
 * iOS (Swift) support for `clerk init`.
 *
 * The Clerk iOS SDK ships via Swift Package Manager and the publishable key is
 * configured in Swift source (`Clerk.configure(publishableKey:)`), not an env
 * file — and adding an SPM dependency requires editing the Xcode project
 * bundle, which is not safe to automate. So instead of writing files, this
 * scaffolder prints the exact quickstart steps; `clerk init` still links the
 * app and pulls real keys so the user can copy the publishable key.
 *
 * Docs: https://clerk.com/docs/ios/getting-started/quickstart
 */
export const ios: FrameworkScaffold = {
  name: "iOS (Swift)",
  dep: "ios",

  matches: (ctx) => ctx.framework.dep === "ios",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    return {
      actions: [],
      postInstructions: [
        "Add the Clerk iOS SDK via Swift Package Manager: https://github.com/clerk/clerk-ios (add both ClerkKit and ClerkKitUI to your target)",
        "Enable the Native API and register your iOS app (App ID Prefix + Bundle ID) on the Native Applications page: https://dashboard.clerk.com/~/native-applications",
        "In Xcode, add the Associated Domains capability with `webcredentials:<your-frontend-api-url>`",
        `Configure Clerk in your @main App struct: \`Clerk.configure(publishableKey: "<publishable key>")\` — copy CLERK_PUBLISHABLE_KEY from ${ctx.envFile} after \`clerk env pull\``,
        "Full setup guide: https://clerk.com/docs/ios/getting-started/quickstart",
      ],
    };
  },
};
