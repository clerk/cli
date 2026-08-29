import type { FrameworkScaffold, ProjectContext, ScaffoldPlan } from "./types.js";
import { planIOSDirectConfig } from "../ios/direct-config.ts";
import { inspectIOSProject } from "../ios/inspect.ts";
import { buildIOSSetupPlan } from "../ios/plan.ts";
import {
  clerkKitUIInstallDecision,
  hasSupportedIOSCustomConfigure,
  shouldPlanIOSDirectConfig,
} from "../ios/products.ts";
import { planIOSAssociatedDomain } from "../ios/associated-domain.ts";

/**
 * iOS (Swift) support for `clerk init`.
 *
 * The Clerk iOS SDK ships via Swift Package Manager and the publishable key is
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
  name: "iOS (Swift)",
  dep: "ios",

  matches: (ctx) => ctx.framework.dep === "ios",

  async scaffold(ctx: ProjectContext): Promise<ScaffoldPlan> {
    const inspection = await inspectIOSProject(ctx.cwd, { target: ctx.iosTarget });
    const selection = inspection.selection;
    const target =
      selection.state === "selected"
        ? inspection.appTargets.find(
            (candidate) =>
              candidate.id === selection.targetId &&
              candidate.projectPath === selection.projectPath,
          )
        : undefined;
    const productDecision = target ? clerkKitUIInstallDecision(target) : "prebuilt";
    const includeClerkKitUI = productDecision === "prebuilt";
    const hasCustomConfigure = target != null && hasSupportedIOSCustomConfigure(target);
    const shouldPlanDirectConfig =
      selection.state === "selected" &&
      target != null &&
      shouldPlanIOSDirectConfig(inspection, target, productDecision);
    const directConfigPlan =
      shouldPlanDirectConfig && selection.state === "selected"
        ? await planIOSDirectConfig({
            root: ctx.cwd,
            projectPath: selection.projectPath,
            targetId: selection.targetId,
          })
        : undefined;
    const associatedDomainPlan =
      selection.state === "selected"
        ? await planIOSAssociatedDomain({
            root: ctx.cwd,
            projectPath: selection.projectPath,
            targetId: selection.targetId,
            deferToPublishableKey:
              directConfigPlan?.status === "ready" || hasCustomConfigure === true,
            allowMissingEntitlementsCreation: true,
          })
        : undefined;
    const setupPlan = buildIOSSetupPlan(inspection, {
      directConfigPlan,
      associatedDomainPlan,
    });
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
                  "Add the Clerk iOS SDK via Swift Package Manager: https://github.com/clerk/clerk-ios (link ClerkKit and ClerkKitUI for the fastest prebuilt AuthView path)",
                ]
              : [
                  "Add the Clerk iOS SDK via Swift Package Manager: https://github.com/clerk/clerk-ios (link ClerkKit for this existing custom-flow path)",
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
            "Enable the Native API and register your iOS app (App ID Prefix + Bundle ID) on the Native Applications page: https://dashboard.clerk.com/~/native-applications",
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
        "Full setup guide: https://clerk.com/docs/ios/getting-started/quickstart",
      ],
    };
  },
};
