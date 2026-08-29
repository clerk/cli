import type {
  IOSAppTarget,
  IOSProjectInspectionResult,
  IOSSetupPlan,
  IOSSetupStep,
  IOSSetupStepStatus,
  IOSSourceEvidence,
  IOSValueResolution,
} from "./types.ts";
import { clerkKitUIInstallDecision } from "./products.ts";
import type { IOSDirectConfigPlan } from "./direct-config.ts";
import { associatedDomainMatches, type IOSAssociatedDomainPlan } from "./associated-domain.ts";
import type { IOSAppleEntitlementPlan } from "./apple-entitlement.ts";
import type { IOSPrebuiltAuthPlan } from "./prebuilt-auth.ts";
import type { IOSSDKInstallPlan } from "./install-sdk.ts";
import { normalizeBundleIdentifierIdentity } from "../../../lib/apple-native-identity.ts";

const NATIVE_APPLICATIONS_URL = "https://dashboard.clerk.com/~/native-applications";
const QUICKSTART_URL = "https://clerk.com/docs/ios/getting-started/quickstart";
const NATIVE_APPLE_URL =
  "https://clerk.com/docs/ios/guides/configure/auth-strategies/sign-in-with-apple";

function selectedTarget(inspection: IOSProjectInspectionResult): IOSAppTarget | undefined {
  const selection = inspection.selection;
  if (selection.state !== "selected") return undefined;
  return inspection.appTargets.find(
    (target) => target.id === selection.targetId && target.projectPath === selection.projectPath,
  );
}

function selectedEvidence(target: IOSAppTarget | undefined): IOSSourceEvidence[] {
  return target ? [{ path: target.projectPath, objectId: target.id }] : [];
}

function distinctResolvedBundleIdentifiers(target: IOSAppTarget): string[] {
  const candidatesByIdentity = new Map<string, string>();
  for (const configuration of target.configurations) {
    const value = configuration.bundleIdentifier;
    if (value.state !== "resolved") continue;
    const identity = normalizeBundleIdentifierIdentity(value.value);
    if (!candidatesByIdentity.has(identity)) candidatesByIdentity.set(identity, value.value);
  }
  return [...candidatesByIdentity.values()].sort();
}

function allEvidence(
  target: IOSAppTarget,
  select: (configuration: IOSAppTarget["configurations"][number]) => IOSValueResolution,
): IOSSourceEvidence[] {
  return target.configurations.flatMap((configuration) => select(configuration).evidence);
}

function step(
  id: IOSSetupStep["id"],
  title: string,
  status: IOSSetupStepStatus,
  description: string,
  evidence: IOSSourceEvidence[] = [],
  links?: IOSSetupStep["links"],
  automatable = false,
): IOSSetupStep {
  return { id, title, status, automatable, description, links, evidence };
}

export interface BuildIOSSetupPlanOptions {
  /** Strict SDK/package compatibility from the same planner used by apply. */
  sdkInstallPlan?: Pick<IOSSDKInstallPlan, "status" | "blockers">;
  /** Strict, publishable-key-redacted Swift source readiness from the apply planner. */
  directConfigPlan?: IOSDirectConfigPlan;
  /** Strict existing-entitlements readiness from the same planner used by apply. */
  associatedDomainPlan?: Pick<
    IOSAssociatedDomainPlan,
    | "status"
    | "expectedDomain"
    | "requiresPublishableKey"
    | "blockers"
    | "files"
    | "missingEntitlementsSettings"
  >;
  /** Optional native Apple capability requested or already present locally. */
  appleEntitlementPlan?: Pick<IOSAppleEntitlementPlan, "status" | "actions" | "blockers">;
  /** Strict source readiness for the optional prebuilt AuthView scaffold. */
  prebuiltAuthPlan?: Pick<IOSPrebuiltAuthPlan, "status" | "sourcePath" | "actions" | "blockers">;
  /** Whether this invocation explicitly selected the optional AuthView scaffold. */
  prebuiltAuthSelected?: boolean;
}

export function buildIOSSetupPlan(
  inspection: IOSProjectInspectionResult,
  options: BuildIOSSetupPlanOptions = {},
): IOSSetupPlan {
  const target = selectedTarget(inspection);
  const targetEvidence = selectedEvidence(target);
  const steps: IOSSetupStep[] = [];
  const platform =
    target?.platform ??
    (inspection.platform === "ios" || inspection.platform === "macos"
      ? inspection.platform
      : undefined);
  const platformLabel =
    platform === "macos" ? "macOS" : platform === "ios" ? "iOS" : "native Apple";
  const selectTargetTitle =
    platform === "macos"
      ? "Select the macOS application target"
      : platform === "ios"
        ? "Select the iOS application target"
        : "Select the native Apple application target";

  steps.push(
    step(
      "select-target",
      selectTargetTitle,
      target ? "satisfied" : "blocked",
      target
        ? `Using ${target.name} in ${target.projectPath}.`
        : inspection.selection.state === "ambiguous"
          ? "More than one native Apple app target is eligible. Rerun with --target <name-or-id>; the CLI will not guess."
          : inspection.selection.state === "not-found"
            ? `The requested target "${inspection.selection.requested}" was not found.${
                inspection.selection.candidates.length > 0
                  ? ` Available targets: ${inspection.selection.candidates.join(", ")}.`
                  : ""
              }`
            : "No usable iOS or macOS application target was found.",
      targetEvidence,
    ),
  );

  if (!target) {
    const blockedSteps: Array<[IOSSetupStep["id"], string]> = [
      [
        "install-clerk-sdk",
        platform === "macos"
          ? "Install Clerk's Swift SDK"
          : platform === "ios"
            ? "Install Clerk's iOS SDK"
            : "Install Clerk's native SDK",
      ],
      ["configure-publishable-key", "Configure Clerk"],
      ["inject-clerk-environment", "Inject Clerk into SwiftUI"],
      [
        "register-native-application",
        platform === "macos"
          ? "Register the macOS application"
          : platform === "ios"
            ? "Register the iOS application"
            : "Register the native application",
      ],
      ["add-authentication-flow", "Add an authentication flow"],
      ["verify-integration", "Verify the integration"],
    ];
    for (const [id, title] of blockedSteps) {
      steps.push(
        step(
          id,
          title,
          "blocked",
          "Select a native Apple application target before planning this step.",
        ),
      );
    }
    return finishPlan(inspection, steps);
  }

  const usesClerkKitUI = target.swift.importsClerkKitUI.length > 0;
  const productDecision = clerkKitUIInstallDecision(target);
  const includeClerkKitUI =
    productDecision === "prebuilt" ||
    options.prebuiltAuthSelected === true ||
    options.prebuiltAuthPlan?.status === "satisfied";
  const sourceEntryPointIsAmbiguous = target.swift.status === "ambiguous";
  const requiredProductsLinked =
    target.packages.clerkKit === "linked" &&
    (!includeClerkKitUI || target.packages.clerkKitUI === "linked");
  const packageIsVerified =
    target.packages.package === "remote" || target.packages.package === "local";
  const strictSDKBlocked = options.sdkInstallPlan?.status === "blocked";
  const strictSDKBlocker = strictSDKBlocked
    ? options.sdkInstallPlan?.blockers.map((blocker) => blocker.message).join(" ")
    : undefined;
  const sdkStatus: IOSSetupStepStatus = strictSDKBlocked
    ? "blocked"
    : productDecision === "unknown"
      ? "review"
      : !requiredProductsLinked
        ? "required"
        : packageIsVerified
          ? "satisfied"
          : target.packages.package === "unattributed"
            ? "review"
            : "required";
  const sdkAutomatable =
    sdkStatus === "required" &&
    inspection.generatedProject === null &&
    target.packages.package !== "unattributed";
  steps.push(
    step(
      "install-clerk-sdk",
      target.platform === "macos"
        ? "Install Clerk's Swift SDK for the selected target"
        : "Install Clerk's iOS SDK for the selected target",
      sdkStatus,
      strictSDKBlocked
        ? `The selected Clerk ${target.platform === "macos" ? "Swift" : "iOS"} SDK cannot support this approved setup safely: ${
            strictSDKBlocker ?? "Update the clerk-ios package and rerun the plan."
          }`
        : productDecision === "unknown"
          ? `Swift source membership for ${target.name} is incomplete, so the CLI cannot safely choose between the prebuilt ClerkKitUI path and a core-only custom flow. Resolve the source-membership diagnostics or make the product choice manually.`
          : sdkStatus === "satisfied"
            ? `ClerkKit is linked to ${target.name}${
                target.packages.clerkKitUI === "linked" ? "; ClerkKitUI is linked too" : ""
              }.`
            : sdkStatus === "review"
              ? `ClerkKit${
                  target.packages.clerkKitUI === "linked" ? " and ClerkKitUI are" : " is"
                } linked to ${
                  target.name
                }, but the package reference could not be verified as clerk-ios. Confirm the linked products come from Clerk's remote or local package.`
              : includeClerkKitUI && target.packages.clerkKitUI !== "linked"
                ? usesClerkKitUI
                  ? `${target.name} imports ClerkKitUI, but that product is not linked to the target. Link both ClerkKit and ClerkKitUI from the clerk-ios Swift package.`
                  : target.packages.clerkKitUI === "declared"
                    ? `ClerkKitUI is declared for ${target.name} but not linked in its Frameworks phase. Link it alongside ClerkKit.`
                    : target.packages.clerkKit !== "absent"
                      ? `${target.name} already has ClerkKit but no source-proven custom flow. Link ClerkKitUI from the same clerk-ios package so the prebuilt AuthView path is ready by default.`
                      : `${target.name} has no existing Clerk integration. Link both ClerkKit and ClerkKitUI from the clerk-ios Swift package so the prebuilt AuthView is ready by default.`
                : includeClerkKitUI
                  ? `Add https://github.com/clerk/clerk-ios with Swift Package Manager and link ClerkKit and ClerkKitUI to ${target.name} for the fastest prebuilt AuthView path.`
                  : `${target.name} already shows core-only or custom-flow intent. Add https://github.com/clerk/clerk-ios with Swift Package Manager and link ClerkKit; ClerkKitUI is not required for that path.`,
      targetEvidence,
      undefined,
      sdkAutomatable,
    ),
  );

  const configured = target.swift.configureCalls.length > 0;
  const oneStartupConfigure =
    target.swift.evidenceComplete &&
    !sourceEntryPointIsAmbiguous &&
    target.swift.configureCalls.length === 1 &&
    target.swift.configureCalls[0]?.startupBinding === "app-init";
  const configureCall = target.swift.configureCalls[0];
  const inlineConfigureValid =
    oneStartupConfigure &&
    configureCall?.publishableKeyWiring === "inline-literal" &&
    configureCall.inlinePublishableKey?.state === "valid";
  const customConfigureReady =
    oneStartupConfigure && configureCall?.publishableKeyWiring === "custom";
  const publishableKeyBlocked =
    oneStartupConfigure &&
    configureCall?.publishableKeyWiring === "inline-literal" &&
    configureCall.inlinePublishableKey?.state === "invalid";
  const directConfigPlanApplies = options.directConfigPlan != null;
  const directConfigAutomationReady =
    directConfigPlanApplies &&
    options.directConfigPlan?.status === "ready" &&
    options.directConfigPlan.changes?.configuration !== "verify-existing";
  const directConfigBlocked =
    directConfigPlanApplies && options.directConfigPlan?.status === "blocked";
  const directConfigBlocker = directConfigBlocked
    ? options.directConfigPlan?.blockers.map((blocker) => blocker.message).join(" ")
    : undefined;
  const configuredStatus: IOSSetupStepStatus = publishableKeyBlocked
    ? "blocked"
    : directConfigBlocked
      ? "blocked"
      : configured
        ? inlineConfigureValid || customConfigureReady
          ? "satisfied"
          : "review"
        : directConfigAutomationReady
          ? "required"
          : target.swift.evidenceComplete
            ? "required"
            : "review";
  steps.push(
    step(
      "configure-publishable-key",
      "Configure Clerk with a publishable key",
      configuredStatus,
      publishableKeyBlocked
        ? "The inline Clerk publishable key is malformed. Replace it before relying on Clerk.configure(...)."
        : directConfigBlocked
          ? `Automatic direct configuration stopped because the selected Swift startup source is not safe to edit: ${
              directConfigBlocker ??
              "Review the selected target's @main App initializer and root Scene manually."
            }`
          : configured
            ? target.swift.configureCalls.length > 1
              ? "More than one Clerk.configure(...) call is present. Confirm which call configures the shipping app before continuing."
              : sourceEntryPointIsAmbiguous
                ? "A Clerk.configure(...) call is present, but multiple @main entry points make startup ownership ambiguous. Confirm which entry point ships."
                : inlineConfigureValid
                  ? "Clerk is configured directly in the selected target's @main initializer with a valid publishable key. The value is intentionally redacted from this plan."
                  : customConfigureReady
                    ? "Clerk is configured at app startup through a custom publishable-key source. clerk init will preserve that source and require the developer to select its Clerk application; the value is not inspected or independently verified."
                    : "A Clerk.configure(...) call is present, but it is not proven to run from the selected app's startup initializer. Confirm the shipping configuration manually; the expression is intentionally redacted."
            : !target.swift.evidenceComplete
              ? "No Clerk.configure(...) call was found in the safely inspected source subset. Complete source membership inspection or confirm startup setup manually."
              : directConfigAutomationReady
                ? `clerk init can add Clerk.configure(publishableKey:) directly to ${
                    options.directConfigPlan?.sourcePath ??
                    "the single shipping @main App initializer"
                  } with the selected application's development key. The preview and result keep the value redacted.`
                : "Select a Clerk application and call Clerk.configure(publishableKey:) with its development publishable key directly in the selected target's @main App initializer.",
      target.swift.configureCalls,
      undefined,
      directConfigAutomationReady,
    ),
  );

  const provenAppRoot =
    !sourceEntryPointIsAmbiguous &&
    target.swift.entryPoints.length === 1 &&
    target.swift.appRootEvidence.length === 1 &&
    target.swift.appRootEvidence[0]?.path === target.swift.entryPoints[0]?.path;
  const injected =
    provenAppRoot &&
    target.swift.rootEnvironmentInjections.some(
      (evidence) => evidence.path === target.swift.appRootEvidence[0]?.path,
    );
  const hasUnprovenInjection = target.swift.environmentInjections.length > 0 && !injected;
  const requiresSwiftUIEnvironment =
    target.swift.environmentConsumers.length > 0 || includeClerkKitUI || directConfigPlanApplies;
  const directEnvironmentAutomationReady =
    directConfigPlanApplies &&
    options.directConfigPlan?.status === "ready" &&
    options.directConfigPlan.changes?.environment === "insert";
  const directEnvironmentBlocked = !injected && requiresSwiftUIEnvironment && directConfigBlocked;
  const injectedStatus: IOSSetupStepStatus = injected
    ? "satisfied"
    : directEnvironmentBlocked
      ? "blocked"
      : requiresSwiftUIEnvironment
        ? target.swift.evidenceComplete && provenAppRoot && !hasUnprovenInjection
          ? "required"
          : "review"
        : "review";
  steps.push(
    step(
      "inject-clerk-environment",
      "Inject Clerk into the SwiftUI environment",
      injectedStatus,
      injected
        ? "Clerk.shared is injected into the proven shipping WindowGroup root."
        : directEnvironmentBlocked
          ? `Automatic SwiftUI environment injection stopped because the selected startup source is not safe to edit: ${
              directConfigBlocker ?? "Review the selected target's WindowGroup root manually."
            }`
          : hasUnprovenInjection
            ? "A Clerk.shared environment modifier exists in target source, but it is not proven on the shipping WindowGroup root. Confirm the mounted root manually."
            : requiresSwiftUIEnvironment && !provenAppRoot
              ? "The shipping SwiftUI root could not be proven structurally. Confirm that its mounted root injects Clerk.shared."
              : target.swift.evidenceComplete && requiresSwiftUIEnvironment
                ? directEnvironmentAutomationReady
                  ? `clerk init can add \`.environment(Clerk.shared)\` to the proven WindowGroup root in ${
                      options.directConfigPlan?.sourcePath ?? "the single shipping @main App source"
                    }.`
                  : "At the app's root view, add `.environment(Clerk.shared)` so Clerk-aware views receive the configured client."
                : requiresSwiftUIEnvironment
                  ? "Clerk.shared injection was not found in the safely inspected source subset. Confirm the shipping root manually."
                  : "No target source was found consuming Clerk from SwiftUI's environment. Add `.environment(Clerk.shared)` only if AuthView or an `@Environment(Clerk.self)` view needs it.",
      injected ? target.swift.rootEnvironmentInjections : target.swift.environmentInjections,
      undefined,
      directEnvironmentAutomationReady,
    ),
  );

  const bundleIdentifiers = distinctResolvedBundleIdentifiers(target);
  const appPrefixes = [
    ...new Set(
      target.configurations
        .map((configuration) => configuration.entitlements?.literalAppIdentifierPrefix)
        .filter((value): value is string => value != null),
    ),
  ].sort();
  const registrationBlocked =
    target.configurations.length === 0 ||
    target.configurations.some(
      (configuration) => configuration.bundleIdentifier.state !== "resolved",
    ) ||
    bundleIdentifiers.length !== 1;
  steps.push(
    step(
      "register-native-application",
      target.platform === "macos"
        ? "Register the macOS app in Clerk Dashboard"
        : "Register the iOS app in Clerk Dashboard",
      registrationBlocked ? "blocked" : "review",
      registrationBlocked
        ? "A single Bundle ID could not be resolved across build configurations. Make it explicit or consistent before registering the app."
        : appPrefixes.length === 1
          ? `The source entitlements contain the literal App ID Prefix candidate ${appPrefixes[0]} for ${bundleIdentifiers[0]}. Confirm it in Apple Developer, then verify the app is registered and Native API is enabled. Dashboard state is not changed or assumed by dry-run.`
          : `Verify that ${bundleIdentifiers[0]} is registered and Native API is enabled. Supply the Apple App ID Prefix from the Developer portal; DEVELOPMENT_TEAM is not assumed to be the prefix.`,
      allEvidence(target, (configuration) => configuration.bundleIdentifier),
      [{ kind: "dashboard", url: NATIVE_APPLICATIONS_URL }],
    ),
  );

  if (options.appleEntitlementPlan) {
    const appleStatus: IOSSetupStepStatus =
      options.appleEntitlementPlan.status === "ready"
        ? "required"
        : options.appleEntitlementPlan.status === "satisfied"
          ? "satisfied"
          : "blocked";
    const description =
      options.appleEntitlementPlan.status === "ready"
        ? "Add the native Sign in with Apple entitlement with the exact Default value. After authentication, clerk init will separately audit and enable the matching Clerk Apple connection without requesting hosted/web Apple credentials."
        : options.appleEntitlementPlan.status === "satisfied"
          ? "The selected target has the exact native Sign in with Apple entitlement. Regular clerk init will verify the matching Clerk Apple connection after authentication."
          : `Native Sign in with Apple needs review: ${options.appleEntitlementPlan.blockers
              .map((item) => item.message)
              .join(" ")}`;
    steps.push(
      step(
        "enable-native-apple",
        "Enable native Sign in with Apple",
        appleStatus,
        description,
        target.configurations.flatMap((configuration) => configuration.entitlementsPath.evidence),
        [{ kind: "documentation", url: NATIVE_APPLE_URL }],
        options.appleEntitlementPlan.status === "ready",
      ),
    );
  }

  const expectedDomain =
    inspection.localPublishableKey.state === "valid"
      ? `webcredentials:${inspection.localPublishableKey.frontendApiHost}`
      : undefined;
  const expectedDomainIsSelectedTargetRuntime = inlineConfigureValid;
  const entitlements = target.configurations
    .map((configuration) => configuration.entitlements)
    .filter((value) => value != null);
  const allEntitlementsPresent =
    entitlements.length === target.configurations.length && entitlements.length > 0;
  const domainPresent =
    expectedDomain != null &&
    allEntitlementsPresent &&
    entitlements.every((value) =>
      value.associatedDomains.some((domain) => associatedDomainMatches(domain, expectedDomain)),
    );
  const hasUnresolvedAssociatedDomains = entitlements.some(
    (value) => value.unresolvedAssociatedDomains.length > 0,
  );
  const associatedDomainPlan = options.associatedDomainPlan;
  const associatedDomainStatus: IOSSetupStepStatus =
    associatedDomainPlan?.status === "ready"
      ? "required"
      : associatedDomainPlan?.status === "satisfied"
        ? "satisfied"
        : associatedDomainPlan?.status === "blocked"
          ? "review"
          : expectedDomain && !expectedDomainIsSelectedTargetRuntime
            ? "review"
            : domainPresent
              ? "satisfied"
              : expectedDomain && allEntitlementsPresent && hasUnresolvedAssociatedDomains
                ? "review"
                : expectedDomain
                  ? "required"
                  : "blocked";
  const associatedDomainDescription =
    associatedDomainPlan?.status === "ready"
      ? associatedDomainPlan.expectedDomain
        ? associatedDomainPlan.missingEntitlementsSettings
          ? `Create and attach ${
              associatedDomainPlan.files[0]?.path ?? "an entitlements file"
            } only to iPhone and iPad builds, then add ${
              associatedDomainPlan.expectedDomain
            }. clerk init can apply this safely.`
          : `Add ${associatedDomainPlan.expectedDomain} to every selected-target entitlements configuration. clerk init can apply the exact existing-file edits safely.`
        : associatedDomainPlan.missingEntitlementsSettings
          ? `The selected target has one safe synchronized destination for a new entitlements file. clerk init will create and attach it only to iPhone and iPad builds, then add the linked development application's exact webcredentials host without exposing the publishable key.`
          : "The existing selected-target entitlements files are safe to edit. clerk init will derive the exact webcredentials host from the linked development application after authentication and add it without exposing the publishable key."
      : associatedDomainPlan?.status === "blocked"
        ? `Automatic Associated Domains setup needs review: ${associatedDomainPlan.blockers
            .map((blocker) => blocker.message)
            .join(" ")}`
        : expectedDomain && !expectedDomainIsSelectedTargetRuntime
          ? domainPresent
            ? `${expectedDomain} matches every inspected entitlements configuration, but the key is only available to copy and is not proven to be the selected target's runtime key. Confirm the runtime key before treating this domain as final.`
            : `The available key candidate maps to ${expectedDomain}, but it is not proven to be the selected target's runtime key. Wire or confirm the runtime key before adding its Associated Domain.`
          : domainPresent
            ? `${expectedDomain} is present in every inspected entitlements configuration.`
            : expectedDomain
              ? allEntitlementsPresent && hasUnresolvedAssociatedDomains
                ? `Some associated-domain values use unresolved build settings. Confirm they expand to ${expectedDomain} in every selected-target configuration.`
                : `Enable Associated Domains for ${target.name} and add ${expectedDomain} to every selected-target entitlements configuration.`
              : "A valid local publishable key is needed to derive the exact `webcredentials:` Frontend API host. Add the key, then rerun this plan.";
  if (target.platform === "ios") {
    steps.push(
      step(
        "add-associated-domain",
        "Add Clerk's associated domain",
        associatedDomainStatus,
        associatedDomainDescription,
        target.configurations.flatMap((configuration) => configuration.entitlementsPath.evidence),
        undefined,
        associatedDomainPlan?.status === "ready",
      ),
    );
  }

  const hasAuthFlow = target.swift.authFlowReferences.length > 0;
  const prebuiltAuthReady = options.prebuiltAuthPlan?.status === "ready" && !strictSDKBlocked;
  const prebuiltAuthSatisfied = options.prebuiltAuthPlan?.status === "satisfied";
  const selectedPrebuiltAuthBlocked =
    options.prebuiltAuthSelected === true &&
    (options.prebuiltAuthPlan?.status === "blocked" || strictSDKBlocked);
  const authFlowStatus: IOSSetupStepStatus = selectedPrebuiltAuthBlocked
    ? "blocked"
    : hasAuthFlow || prebuiltAuthSatisfied
      ? sourceEntryPointIsAmbiguous
        ? "review"
        : "satisfied"
      : prebuiltAuthReady
        ? "required"
        : target.swift.evidenceComplete
          ? "required"
          : "review";
  steps.push(
    step(
      "add-authentication-flow",
      "Add an authentication flow",
      authFlowStatus,
      selectedPrebuiltAuthBlocked
        ? `The prebuilt AuthView scaffold was requested, but this app is not safe to rewrite automatically: ${
            strictSDKBlocker ??
            options.prebuiltAuthPlan?.blockers.map((blocker) => blocker.message).join(" ") ??
            "Review the existing signed-out route and integrate AuthView manually."
          } Linked AuthView providers are not inspected by this network-free local plan.`
        : hasAuthFlow || prebuiltAuthSatisfied
          ? sourceEntryPointIsAmbiguous
            ? "A Clerk authentication flow is referenced, but multiple @main entry points make the shipping route ambiguous."
            : prebuiltAuthSatisfied
              ? "ClerkKitUI's documented UserButton entry and AuthView sheet are already configured in target source."
              : "A Clerk authentication UI or sign-in/sign-up flow is referenced in target source."
          : prebuiltAuthReady
            ? options.prebuiltAuthSelected
              ? `Add ClerkKitUI's documented UserButton entry, AuthView sheet, and image prefetching to ${
                  options.prebuiltAuthPlan?.sourcePath ?? "the proven placeholder SwiftUI view"
                }. Linked AuthView providers are not inspected by this network-free local plan; regular clerk init will add or verify the local Sign in with Apple entitlement only if Apple is enabled for the linked instance.`
              : `This target's pristine placeholder is eligible for the optional prebuilt AuthView scaffold. Run clerk init with --prebuilt-auth-ui or select it when prompted; existing application UI is never replaced automatically.`
            : target.swift.evidenceComplete
              ? productDecision === "core-only"
                ? "Complete the custom ClerkKit sign-in/sign-up flow and route signed-out users to it."
                : "Present ClerkKitUI's AuthView or build a custom ClerkKit sign-in/sign-up flow, then route signed-out users to it."
              : "No Clerk authentication flow was found in the safely inspected source subset. Confirm the signed-out route manually.",
      target.swift.authFlowReferences,
      undefined,
      prebuiltAuthReady,
    ),
  );

  const actionable = steps.some((item) => item.status === "required" || item.status === "blocked");
  steps.push(
    step(
      "verify-integration",
      "Build and verify sign-in",
      "review",
      actionable
        ? "After completing the required steps, build the selected target and verify sign-in, sign-out, app relaunch, and any redirect-based method you enabled."
        : "The local evidence looks complete. Build the selected target and verify sign-in, sign-out, app relaunch, and any redirect-based method you enabled.",
      targetEvidence,
      [{ kind: "documentation", url: QUICKSTART_URL }],
    ),
  );

  return finishPlan(inspection, steps);
}

function finishPlan(inspection: IOSProjectInspectionResult, steps: IOSSetupStep[]): IOSSetupPlan {
  const summary: IOSSetupPlan["summary"] = {
    satisfied: 0,
    required: 0,
    review: 0,
    blocked: 0,
  };
  for (const item of steps) summary[item.status]++;
  const status: IOSSetupPlan["status"] =
    summary.blocked > 0 ? "blocked" : summary.required > 0 ? "action-required" : "ready";

  return {
    schemaVersion: 1,
    kind: "clerk-ios-setup",
    root: inspection.root,
    status,
    selection: inspection.selection,
    summary,
    steps,
    diagnostics: inspection.diagnostics,
  };
}
