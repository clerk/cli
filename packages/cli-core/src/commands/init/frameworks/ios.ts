import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";
import { inspectIOSProject } from "../ios/inspect.ts";
import { buildIOSLocalSetupProposal, createIOSLocalSetupContext } from "../ios/local-plan.ts";

/**
 * Native Apple (Swift) support for `clerk init`.
 *
 * The Clerk Swift SDK ships via Swift Package Manager and the publishable key is
 * configured in Swift source (`Clerk.configure(publishableKey:)`), not an env
 * file. The dedicated iOS apply phase safely handles the selected target's SPM
 * product linkage before this scaffolder runs. For a safely inspectable fresh
 * SwiftUI target, init configures the linked development publishable key
 * directly in the shipping @main App source. Existing custom key sources are
 * preserved and require the developer to select their Clerk application.
 *
 * Docs: https://clerk.com/docs/ios/getting-started/quickstart
 */
export const ios: FrameworkScaffold = {
  name: "Native Apple (Swift)",
  dep: "ios",

  matches: (ctx) => ctx.framework.dep === "ios",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    // Rebuild the aggregate proposal from post-apply state so guidance describes remaining work.
    const inspection = await inspectIOSProject(ctx.cwd, {
      target: ctx.iosTarget,
      exhaustiveContainerDiscovery: true,
    });
    const proposal = await buildIOSLocalSetupProposal(createIOSLocalSetupContext(inspection), {
      root: ctx.cwd,
      allowDirty: true,
      prebuiltAuthUI: false,
      signInWithApple: false,
    });
    const selection = inspection.selection;
    const target = proposal.selectedTarget;
    const platform =
      proposal.platform ??
      (ctx.framework.name === "macOS (Swift)"
        ? "macos"
        : ctx.framework.name === "iOS (Swift)"
          ? "ios"
          : undefined);
    const platformLabel =
      platform === "macos" ? "macOS" : platform === "ios" ? "iOS" : "native Apple";
    const sdkLabel = platform === "ios" ? "Clerk iOS SDK" : "Clerk Swift SDK";
    const productDecision = proposal.productDecision ?? "prebuilt";
    const includeClerkKitUI = productDecision === "prebuilt";
    const hasCustomConfigure = proposal.hasSupportedCustomConfigure;
    const setupPlan = proposal.setupPlan;
    const platformCompatibilityBlockers = proposal.platformCompatibilityBlockers;
    if (platformCompatibilityBlockers.length > 0) {
      return {
        actions: [],
        postInstructions: [
          ...platformCompatibilityBlockers,
          "Automatic setup stopped before using one platform's Swift setup or Bundle ID for the whole target. Make the supported-platform setup consistent, then rerun clerk init.",
          platform === "ios"
            ? "Full setup guide: https://clerk.com/docs/ios/getting-started/quickstart"
            : "Clerk Swift SDK guide: https://github.com/clerk/clerk-ios",
        ],
      };
    }
    const configureStep = setupPlan.steps.find((step) => step.id === "configure-publishable-key");
    const needsAttention = (id: string) => {
      const setupStep = setupPlan.steps.find((step) => step.id === id);
      return setupStep != null && setupStep.status !== "satisfied";
    };
    const packageIsVerified =
      target?.packages.package === "remote" || target?.packages.package === "local";
    const requiredProductsLinked =
      target?.packages.clerkKit === "linked" &&
      (!includeClerkKitUI || target.packages.clerkKitUI === "linked");
    const installInstructions =
      productDecision === "unknown"
        ? [
            "Swift source membership is incomplete. Confirm whether this target should link ClerkKitUI for prebuilt AuthView or remain ClerkKit-only for a custom flow.",
          ]
        : packageIsVerified && requiredProductsLinked
          ? []
          : packageIsVerified &&
              target?.packages.clerkKit === "linked" &&
              includeClerkKitUI &&
              target.packages.clerkKitUI !== "linked"
            ? [
                "Link ClerkKitUI from the existing clerk-ios Swift package for the fastest prebuilt AuthView path",
              ]
            : includeClerkKitUI
              ? [
                  `Add the ${sdkLabel} via Swift Package Manager: https://github.com/clerk/clerk-ios (link ClerkKit and ClerkKitUI for the fastest prebuilt AuthView path)`,
                ]
              : [
                  `Add the ${sdkLabel} via Swift Package Manager: https://github.com/clerk/clerk-ios (link ClerkKit for this existing custom-flow path)`,
                ];
    const requiresSwiftUIEnvironment =
      target != null && (target.swift.environmentConsumers.length > 0 || includeClerkKitUI);
    const environmentInstructions = needsAttention("inject-clerk-environment")
      ? target?.swift.evidenceComplete === true
        ? requiresSwiftUIEnvironment
          ? [
              "Inject Clerk into the SwiftUI environment so Clerk-aware views can read it via `@Environment(Clerk.self)`: `ContentView().environment(Clerk.shared)`",
            ]
          : []
        : [
            "If AuthView or another view reads Clerk via `@Environment(Clerk.self)`, inject it with `ContentView().environment(Clerk.shared)`",
          ]
      : [];
    const registrationInstructions =
      !ctx.iosNativeRemoteReady && needsAttention("register-native-application")
        ? [
            `Enable the Native API and register your ${platformLabel} app (App ID Prefix + Bundle ID) on the Native Applications page: https://dashboard.clerk.com/~/native-applications`,
          ]
        : [];
    const domainInstructions = needsAttention("add-associated-domain")
      ? [
          "In Xcode, add the Associated Domains capability with `webcredentials:<your-frontend-api-url>`",
        ]
      : [];
    const configureInstructions = needsAttention("configure-publishable-key")
      ? selection.state === "selected" && configureStep?.status === "blocked"
        ? [configureStep.description]
        : hasCustomConfigure
          ? [
              "Keep the existing custom Clerk.configure(...) source unchanged. Select the Clerk application it belongs to during setup, or pass --app <app_id> in agent mode; clerk init does not inspect or rewrite the custom key value.",
            ]
          : [
              'Configure Clerk directly in the single shipping `@main` App initializer with the selected application\'s development publishable key: `Clerk.configure(publishableKey: "<development-publishable-key>")`. For a safely inspectable SwiftUI target, `clerk init` applies this with the value redacted from previews and output.',
            ]
      : [];
    const authFlowInstructions = needsAttention("add-authentication-flow")
      ? [
          productDecision === "core-only"
            ? "Complete the signed-out authentication route with the existing custom ClerkKit sign-in/sign-up flow"
            : productDecision === "unknown"
              ? "Confirm whether the signed-out route should use ClerkKitUI's AuthView or a custom ClerkKit flow"
              : "For a pristine SwiftUI placeholder, rerun `clerk init --prebuilt-auth-ui` to add ClerkKitUI's documented UserButton and AuthView sheet; otherwise add a signed-out authentication route with AuthView or a custom ClerkKit flow without replacing existing application UI",
        ]
      : [];
    const nativeAppleInstructions = ctx.iosNativeAppleReady
      ? [
          productDecision === "prebuilt"
            ? "Native Sign in with Apple is ready; ClerkKitUI's AuthView displays the Apple button automatically"
            : productDecision === "core-only"
              ? "Native Sign in with Apple is ready; a custom flow can start it with `try await Clerk.shared.auth.signInWithApple()`"
              : "Native Sign in with Apple is ready; AuthView displays Apple automatically, while custom flows can call `try await Clerk.shared.auth.signInWithApple()`",
        ]
      : [];
    const setupGuideInstruction =
      platform === "ios"
        ? "Full setup guide: https://clerk.com/docs/ios/getting-started/quickstart"
        : "Clerk Swift SDK guide: https://github.com/clerk/clerk-ios";
    return {
      actions: [],
      postInstructions: [
        ...installInstructions,
        ...registrationInstructions,
        ...domainInstructions,
        ...configureInstructions,
        ...nativeAppleInstructions,
        ...authFlowInstructions,
        ...environmentInstructions,
        setupGuideInstruction,
      ],
    };
  },
};
