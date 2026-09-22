import type { IOSProjectInspectionResult, IOSSetupPlan } from "./types.ts";
import type { IOSAppTarget } from "./types.ts";
import {
  clerkKitUIInstallDecision,
  hasSupportedIOSCustomConfigure,
  shouldPlanIOSDirectConfig,
} from "./products.ts";
import { planIOSPrebuiltAuth, type IOSPrebuiltAuthPlan } from "./prebuilt-auth.ts";
import { planIOSDirectConfig, type IOSDirectConfigPlan } from "./direct-config.ts";
import { planIOSAssociatedDomain, type IOSAssociatedDomainPlan } from "./associated-domain.ts";
import { planIOSAppleEntitlement, type IOSAppleEntitlementPlan } from "./apple-entitlement.ts";
import { planIOSSDKInstall, type IOSSDKInstallPlan } from "./install-sdk.ts";
import { buildIOSSetupPlan } from "./plan.ts";
import {
  buildIOSNativeReadinessAudit,
  suggestAppIdPrefixFromDevelopmentTeam,
  type IOSNativeReadinessAudit,
  type IOSUnverifiedAppIdPrefixSuggestion,
} from "./native-readiness.ts";

type ProductDecision = ReturnType<typeof clerkKitUIInstallDecision>;

export interface IOSLocalSetupContext {
  inspection: IOSProjectInspectionResult;
  selectedTarget?: IOSAppTarget;
  productDecision?: ProductDecision;
}

export interface BuildIOSLocalSetupProposalOptions {
  root: string;
  allowDirty: boolean;
  /** Explicit AuthView choice. Undefined allows the caller to resolve a human choice. */
  prebuiltAuthUI?: boolean;
  /** Explicit native Apple choice. Undefined allows the caller to resolve a human choice. */
  signInWithApple?: boolean;
  resolvePrebuiltAuthRequest?: (options: {
    targetName: string;
    plan: IOSPrebuiltAuthPlan;
  }) => Promise<boolean>;
  resolveNativeAppleRequest?: (options: { bundleIdentifier: string }) => Promise<boolean>;
}

/**
 * One credential-free, mutation-free proposal shared by dry-run and apply.
 * Candidate bytes and prepared mutations never enter this structure.
 */
export interface IOSLocalSetupProposal {
  inspection: IOSProjectInspectionResult;
  selectedTarget?: IOSAppTarget;
  productDecision?: ProductDecision;
  setupPlan: IOSSetupPlan;
  nativeReadiness: IOSNativeReadinessAudit;
  unverifiedAppIdPrefixSuggestion?: IOSUnverifiedAppIdPrefixSuggestion;
  inspectedPrebuiltAuthPlan?: IOSPrebuiltAuthPlan;
  prebuiltAuthPlanForSetup?: IOSPrebuiltAuthPlan;
  prebuiltAuthPlan?: IOSPrebuiltAuthPlan;
  prebuiltRuntimeBlockers: string[];
  prebuiltAuthRequested: boolean;
  prebuiltAuthActive: boolean;
  installPlan?: IOSSDKInstallPlan;
  sdkInstallPlan?: IOSSDKInstallPlan;
  reviewOnlyUnattributedInstall: boolean;
  directConfigPlan?: IOSDirectConfigPlan;
  plannedAssociatedDomain?: IOSAssociatedDomainPlan;
  associatedDomainPlan?: IOSAssociatedDomainPlan;
  inspectedAppleEntitlementPlan?: IOSAppleEntitlementPlan;
  appleEntitlementPlan?: IOSAppleEntitlementPlan;
  prebuiltAuthAppleEntitlementPlan?: IOSAppleEntitlementPlan;
  nativeAppleRequested: boolean;
  hasCustomConfigure: boolean;
  hasSupportedCustomConfigure: boolean;
}

export function createIOSLocalSetupContext(
  inspection: IOSProjectInspectionResult,
): IOSLocalSetupContext {
  const selection = inspection.selection;
  if (selection.state !== "selected") return { inspection };
  const selectedTarget = inspection.appTargets.find(
    (target) => target.id === selection.targetId && target.projectPath === selection.projectPath,
  );
  return {
    inspection,
    selectedTarget,
    productDecision: selectedTarget ? clerkKitUIInstallDecision(selectedTarget) : undefined,
  };
}

/** Keep legacy, fully linked product graphs review-only while preserving every other SDK blocker. */
export function normalizeIOSSDKInstallPlanForSetup(options: {
  installPlan: IOSSDKInstallPlan;
  selectedTarget: IOSAppTarget;
  prebuiltAuthActive: boolean;
}): {
  sdkInstallPlan?: IOSSDKInstallPlan;
  reviewOnlyUnattributedInstall: boolean;
} {
  const { installPlan, selectedTarget, prebuiltAuthActive } = options;
  const reviewOnlyUnattributedInstall =
    !prebuiltAuthActive &&
    installPlan.requirePrebuiltAuthCompatibility !== true &&
    installPlan.status === "blocked" &&
    installPlan.blockers.length > 0 &&
    installPlan.blockers.every((blocker) => blocker.code === "unattributed-product") &&
    installPlan.products.every((product) =>
      product === "ClerkKit"
        ? selectedTarget.packages.clerkKit === "linked"
        : selectedTarget.packages.clerkKitUI === "linked",
    );
  return {
    sdkInstallPlan: reviewOnlyUnattributedInstall ? undefined : installPlan,
    reviewOnlyUnattributedInstall,
  };
}

export function planIOSPrebuiltAuthRuntimeBlockers(
  inspection: IOSProjectInspectionResult,
  directConfigPlan: IOSDirectConfigPlan | undefined,
): string[] {
  const setupPlan = buildIOSSetupPlan(inspection, { directConfigPlan });
  const configureStep = setupPlan.steps.find((step) => step.id === "configure-publishable-key");
  const environmentStep = setupPlan.steps.find((step) => step.id === "inject-clerk-environment");
  const directConfigurationReady =
    directConfigPlan?.status === "ready" && configureStep?.automatable === true;
  const directEnvironmentReady =
    directConfigPlan?.status === "ready" &&
    (directConfigPlan.changes?.environment === "insert" ||
      directConfigPlan.changes?.environment === "satisfied");
  const blockers: string[] = [];

  if (configureStep?.status !== "satisfied" && !directConfigurationReady) {
    blockers.push(
      "Clerk.configure(publishableKey:) is neither proven at runtime nor included in the safe direct-configuration plan.",
    );
  }
  if (environmentStep?.status !== "satisfied" && !directEnvironmentReady) {
    blockers.push(
      "Clerk.shared is not proven in the shipping SwiftUI root environment, and the existing runtime abstraction cannot be rewritten safely.",
    );
  }

  return blockers;
}

export async function buildIOSLocalSetupProposal(
  context: IOSLocalSetupContext,
  options: BuildIOSLocalSetupProposalOptions,
): Promise<IOSLocalSetupProposal> {
  const { inspection, selectedTarget, productDecision } = context;
  const selection = inspection.selection;
  if (selection.state !== "selected" || !selectedTarget || !productDecision) {
    const setupPlan = buildIOSSetupPlan(inspection, {
      prebuiltAuthSelected: options.prebuiltAuthUI === true,
    });
    return {
      inspection,
      selectedTarget,
      productDecision,
      setupPlan,
      nativeReadiness: buildIOSNativeReadinessAudit(inspection),
      prebuiltAuthRequested: options.prebuiltAuthUI === true,
      prebuiltAuthActive: false,
      prebuiltRuntimeBlockers: [],
      reviewOnlyUnattributedInstall: false,
      nativeAppleRequested: options.signInWithApple === true,
      hasCustomConfigure: false,
      hasSupportedCustomConfigure: false,
    };
  }

  const inspectedPrebuiltAuthPlan = await planIOSPrebuiltAuth({
    root: options.root,
    projectPath: selection.projectPath,
    targetId: selection.targetId,
    allowDirty: options.allowDirty,
  });
  let prebuiltAuthRequested = options.prebuiltAuthUI === true;
  if (
    !prebuiltAuthRequested &&
    options.prebuiltAuthUI == null &&
    inspectedPrebuiltAuthPlan.status === "ready" &&
    options.resolvePrebuiltAuthRequest
  ) {
    prebuiltAuthRequested = await options.resolvePrebuiltAuthRequest({
      targetName: selection.targetName,
      plan: inspectedPrebuiltAuthPlan,
    });
  }
  const prebuiltAuthActive =
    inspectedPrebuiltAuthPlan.status !== "blocked" &&
    (prebuiltAuthRequested || inspectedPrebuiltAuthPlan.status === "satisfied");

  const includeClerkKitUI = productDecision === "prebuilt" || prebuiltAuthActive;
  const installPlan = await planIOSSDKInstall({
    root: options.root,
    projectPath: selection.projectPath,
    targetId: selection.targetId,
    includeClerkKitUI,
    requirePrebuiltAuthCompatibility: prebuiltAuthActive,
  });

  const hasCustomConfigure = selectedTarget.swift.configureCalls.some(
    (call) => call.publishableKeyWiring === "custom",
  );
  const hasSupportedCustomConfigure = hasSupportedIOSCustomConfigure(selectedTarget);
  const directConfigPlan = shouldPlanIOSDirectConfig(
    inspection,
    selectedTarget,
    prebuiltAuthActive ? "prebuilt" : productDecision,
  )
    ? await planIOSDirectConfig({
        root: options.root,
        projectPath: selection.projectPath,
        targetId: selection.targetId,
        allowDirty: options.allowDirty,
      })
    : undefined;

  const prebuiltRuntimeBlockers = prebuiltAuthActive
    ? planIOSPrebuiltAuthRuntimeBlockers(inspection, directConfigPlan)
    : [];
  const prebuiltAuthPlanForSetup =
    prebuiltRuntimeBlockers.length > 0
      ? {
          ...inspectedPrebuiltAuthPlan,
          status: "blocked" as const,
          actions: [],
          blockers: [
            ...inspectedPrebuiltAuthPlan.blockers,
            {
              code: "runtime-prerequisites" as const,
              message: prebuiltRuntimeBlockers.join(" "),
            },
          ],
        }
      : inspectedPrebuiltAuthPlan;
  const prebuiltAuthPlan = prebuiltAuthActive ? prebuiltAuthPlanForSetup : undefined;

  const plannedAssociatedDomain = await planIOSAssociatedDomain({
    root: options.root,
    projectPath: selection.projectPath,
    targetId: selection.targetId,
    deferToPublishableKey: directConfigPlan?.status === "ready" || hasSupportedCustomConfigure,
    allowMissingEntitlementsCreation: true,
  });
  const associatedDomainPlan =
    plannedAssociatedDomain.status === "blocked" ? undefined : plannedAssociatedDomain;
  const nativeReadiness = buildIOSNativeReadinessAudit(inspection, {
    associatedDomainPlan: plannedAssociatedDomain,
  });

  const hasLocalAppleEntitlement = selectedTarget.configurations.some(
    (configuration) =>
      configuration.entitlements !== undefined &&
      configuration.entitlements.signInWithAppleState !== "absent",
  );
  let nativeAppleRequested = options.signInWithApple === true;
  if (
    !nativeAppleRequested &&
    options.signInWithApple == null &&
    options.resolveNativeAppleRequest &&
    !(prebuiltAuthRequested && inspectedPrebuiltAuthPlan.status === "blocked") &&
    nativeReadiness.target.status === "selected" &&
    nativeReadiness.target.bundleIdentifier.status === "resolved"
  ) {
    nativeAppleRequested = await options.resolveNativeAppleRequest({
      bundleIdentifier: nativeReadiness.target.bundleIdentifier.value,
    });
  }
  const inspectedAppleEntitlementPlan =
    nativeAppleRequested || hasLocalAppleEntitlement || prebuiltAuthActive
      ? await planIOSAppleEntitlement({
          root: options.root,
          projectPath: selection.projectPath,
          targetId: selection.targetId,
          allowMissingEntitlementsCreation: true,
        })
      : undefined;
  const appleEntitlementPlan = nativeAppleRequested
    ? inspectedAppleEntitlementPlan
    : hasLocalAppleEntitlement && inspectedAppleEntitlementPlan?.status === "blocked"
      ? inspectedAppleEntitlementPlan
      : inspectedAppleEntitlementPlan?.status === "satisfied"
        ? inspectedAppleEntitlementPlan
        : undefined;
  const prebuiltAuthAppleEntitlementPlan = prebuiltAuthActive
    ? inspectedAppleEntitlementPlan
    : undefined;

  const { sdkInstallPlan, reviewOnlyUnattributedInstall } = normalizeIOSSDKInstallPlanForSetup({
    installPlan,
    selectedTarget,
    prebuiltAuthActive,
  });
  const setupPlan = buildIOSSetupPlan(inspection, {
    sdkInstallPlan,
    directConfigPlan,
    associatedDomainPlan: plannedAssociatedDomain,
    appleEntitlementPlan,
    prebuiltAuthPlan: prebuiltAuthPlanForSetup,
    prebuiltAuthSelected: prebuiltAuthRequested,
  });
  const unverifiedAppIdPrefixSuggestion = suggestAppIdPrefixFromDevelopmentTeam(selectedTarget);

  return {
    inspection,
    selectedTarget,
    productDecision,
    setupPlan,
    nativeReadiness,
    ...(unverifiedAppIdPrefixSuggestion ? { unverifiedAppIdPrefixSuggestion } : {}),
    inspectedPrebuiltAuthPlan,
    prebuiltAuthPlanForSetup,
    prebuiltAuthPlan,
    prebuiltRuntimeBlockers,
    prebuiltAuthRequested,
    prebuiltAuthActive,
    installPlan,
    sdkInstallPlan,
    reviewOnlyUnattributedInstall,
    directConfigPlan,
    plannedAssociatedDomain,
    associatedDomainPlan,
    inspectedAppleEntitlementPlan,
    appleEntitlementPlan,
    prebuiltAuthAppleEntitlementPlan,
    nativeAppleRequested,
    hasCustomConfigure,
    hasSupportedCustomConfigure,
  };
}
