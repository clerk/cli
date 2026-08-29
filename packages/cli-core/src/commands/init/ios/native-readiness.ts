import { associatedDomainMatches, type IOSAssociatedDomainPlan } from "./associated-domain.ts";
import { buildIOSSetupPlan } from "./plan.ts";
import { normalizeBundleIdentifierIdentity } from "../../../lib/apple-native-identity.ts";
import type { IOSAppTarget, IOSProjectInspectionResult, IOSSetupStepStatus } from "./types.ts";

export const IOS_NATIVE_READINESS_PLAPI_BRIDGE_REQUIREMENT = {
  applicationId: "linked-application-id",
  instanceId: "linked-development-instance-id",
  authentication: "clerk-cli-bearer-token",
  scope: "applications:read",
  reads: [
    {
      method: "GET",
      path: "/v1/platform/applications/{applicationId}/instances/{instanceId}/native_settings",
      provides: "native-api-state",
    },
    {
      method: "GET",
      path: "/v1/platform/applications/{applicationId}/instances/{instanceId}/native_applications/ios",
      provides: "ios-native-applications",
    },
  ],
} as const;

export type IOSNativeReadinessBundleIdentifier =
  | { status: "resolved"; value: string }
  | { status: "missing" }
  | { status: "unresolved" }
  | { status: "conflicting"; candidates: string[] };

export type IOSNativeReadinessAppIdPrefix =
  | { status: "resolved"; source: "literal-entitlements"; value: string }
  | {
      status: "missing";
      source: "literal-entitlements";
      /** Literal values observed in only part of the selected target's configuration set. */
      candidates?: string[];
    }
  | {
      status: "conflicting";
      source: "literal-entitlements";
      candidates: string[];
    };

/**
 * A human-only convenience value from Xcode signing configuration. This is
 * never treated as proven App ID Prefix evidence because legacy Apple
 * accounts can use a prefix that differs from DEVELOPMENT_TEAM.
 */
export type IOSUnverifiedAppIdPrefixSuggestion = {
  source: "xcode-development-team";
  value: string;
};

export type IOSNativeReadinessTarget =
  | {
      status: "selected";
      projectPath: string;
      targetId: string;
      targetName: string;
      /** Platform selected for this automation run. */
      platform: IOSAppTarget["platform"];
      bundleIdentifier: IOSNativeReadinessBundleIdentifier;
      appIdPrefix: IOSNativeReadinessAppIdPrefix;
    }
  | {
      status: "blocked";
      reason: "target-not-selected" | "selected-target-not-found";
    };

export type IOSAssociatedDomainAutomationBlockerCode =
  | "target-not-selected"
  | "expected-domain-unavailable"
  | "manual-review-required"
  | "generated-project"
  | "missing-build-configurations"
  | "unresolved-entitlements-path"
  | "missing-or-unreadable-entitlements"
  | "unresolved-associated-domains";

export interface IOSAssociatedDomainAutomationBlocker {
  code: IOSAssociatedDomainAutomationBlockerCode;
  message: string;
}

export interface IOSAssociatedDomainReadiness {
  /** The local status from the canonical iOS setup plan. */
  status: IOSSetupStepStatus | "not-applicable";
  /** Exact entitlement value derived from redacted publishable-key metadata. */
  expectedDomain?: string;
  /** Existing, inspected XML entitlements files owned by the selected target. */
  files: string[];
  /** True only when a future writer has a complete, unambiguous local route. */
  automatable: boolean;
  blockers: IOSAssociatedDomainAutomationBlocker[];
}

export interface IOSNativeReadinessAudit {
  schemaVersion: 1;
  kind: "clerk-ios-native-readiness";
  root: string;
  target: IOSNativeReadinessTarget;
  associatedDomain: IOSAssociatedDomainReadiness;
  remote: {
    status: "not-inspected";
    reason: "dry-run-does-not-read-remote-state";
    requirement: typeof IOS_NATIVE_READINESS_PLAPI_BRIDGE_REQUIREMENT;
  };
}

export interface BuildIOSNativeReadinessAuditOptions {
  associatedDomainPlan?: IOSAssociatedDomainPlan;
}

function selectedTarget(inspection: IOSProjectInspectionResult): IOSAppTarget | undefined {
  const selection = inspection.selection;
  if (selection.state !== "selected") return undefined;
  return inspection.appTargets.find(
    (target) => target.id === selection.targetId && target.projectPath === selection.projectPath,
  );
}

function resolvedBundleIdentifiers(target: IOSAppTarget): string[] {
  const candidatesByIdentity = new Map<string, string>();
  for (const configuration of target.configurations) {
    const value = configuration.bundleIdentifier;
    if (value.state !== "resolved") continue;
    const identity = normalizeBundleIdentifierIdentity(value.value);
    if (!candidatesByIdentity.has(identity)) candidatesByIdentity.set(identity, value.value);
  }
  return [...candidatesByIdentity.values()].sort();
}

export function suggestAppIdPrefixFromDevelopmentTeam(
  target: IOSAppTarget,
): IOSUnverifiedAppIdPrefixSuggestion | undefined {
  if (target.configurations.length === 0) return undefined;

  const values = target.configurations.map((configuration) => configuration.developmentTeam);
  if (values.some((value) => value.state !== "resolved")) return undefined;

  const candidates = [
    ...new Set(values.map((value) => (value.state === "resolved" ? value.value.trim() : ""))),
  ];
  if (candidates.length !== 1 || !/^[A-Z0-9]{10}$/.test(candidates[0]!)) return undefined;

  return { source: "xcode-development-team", value: candidates[0]! };
}

function bundleIdentifier(target: IOSAppTarget): IOSNativeReadinessBundleIdentifier {
  if (target.configurations.length === 0) return { status: "missing" };
  if (
    target.configurations.some(
      (configuration) => configuration.bundleIdentifier.state === "missing",
    )
  ) {
    return { status: "missing" };
  }
  if (
    target.configurations.some(
      (configuration) => configuration.bundleIdentifier.state === "unresolved",
    )
  ) {
    return { status: "unresolved" };
  }

  const candidates = resolvedBundleIdentifiers(target);
  if (candidates.length === 1) return { status: "resolved", value: candidates[0]! };
  if (candidates.length === 0) return { status: "missing" };
  return { status: "conflicting", candidates };
}

function appIdPrefix(target: IOSAppTarget): IOSNativeReadinessAppIdPrefix {
  const candidates = [
    ...new Set(
      target.configurations.flatMap((configuration) => {
        const value = configuration.entitlements?.literalAppIdentifierPrefix;
        return value == null ? [] : [value];
      }),
    ),
  ].sort();

  if (
    candidates.length === 1 &&
    target.configurations.length > 0 &&
    target.configurations.every(
      (configuration) => configuration.entitlements?.literalAppIdentifierPrefix === candidates[0],
    )
  ) {
    return {
      status: "resolved",
      source: "literal-entitlements",
      value: candidates[0]!,
    };
  }
  if (candidates.length > 1) {
    return {
      status: "conflicting",
      source: "literal-entitlements",
      candidates,
    };
  }
  return { status: "missing", source: "literal-entitlements", candidates };
}

function targetIdentity(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget | undefined,
): IOSNativeReadinessTarget {
  if (inspection.selection.state !== "selected") {
    return { status: "blocked", reason: "target-not-selected" };
  }
  if (!target) return { status: "blocked", reason: "selected-target-not-found" };

  return {
    status: "selected",
    projectPath: target.projectPath,
    targetId: target.id,
    targetName: target.name,
    platform: target.platform,
    bundleIdentifier: bundleIdentifier(target),
    appIdPrefix: appIdPrefix(target),
  };
}

function associatedDomainReadiness(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget | undefined,
  associatedDomainPlan: IOSAssociatedDomainPlan | undefined,
): IOSAssociatedDomainReadiness {
  if (target?.platform === "macos") {
    return {
      status: "not-applicable",
      files: [],
      automatable: false,
      blockers: [],
    };
  }
  const plan = buildIOSSetupPlan(inspection, { associatedDomainPlan });
  const planStep = plan.steps.find((step) => step.id === "add-associated-domain");
  const host =
    inspection.localPublishableKey.state === "valid"
      ? inspection.localPublishableKey.frontendApiHost
      : undefined;
  const expectedDomain = host ? `webcredentials:${host}` : undefined;
  const files =
    associatedDomainPlan?.files.map((file) => file.path) ??
    (target
      ? [
          ...new Set(
            target.configurations.flatMap((configuration) =>
              configuration.entitlements ? [configuration.entitlements.path] : [],
            ),
          ),
        ].sort()
      : []);
  const everyConfigurationHasExactDomain =
    expectedDomain != null &&
    target != null &&
    target.configurations.length > 0 &&
    target.configurations.every((configuration) =>
      configuration.entitlements?.associatedDomains.some((domain) =>
        associatedDomainMatches(domain, expectedDomain),
      ),
    );
  // The legacy planner accepts Apple's ?mode=developer suffix. Native setup
  // automation intentionally requires the bare production-capable entry.
  const status = associatedDomainPlan
    ? associatedDomainPlan.status === "ready"
      ? "required"
      : associatedDomainPlan.status === "satisfied"
        ? "satisfied"
        : (planStep?.status ?? "blocked")
    : planStep?.status === "satisfied" && !everyConfigurationHasExactDomain
      ? "required"
      : (planStep?.status ?? "blocked");
  const blockers: IOSAssociatedDomainAutomationBlocker[] = [];
  const strictPlanOwnsLocalReadiness =
    associatedDomainPlan?.status === "ready" || associatedDomainPlan?.status === "satisfied";

  if (!target) {
    blockers.push({
      code: "target-not-selected",
      message: "Select exactly one iOS application target before editing entitlements.",
    });
  } else if (!strictPlanOwnsLocalReadiness) {
    if (target.configurations.length === 0) {
      blockers.push({
        code: "missing-build-configurations",
        message: "The selected target has no inspected build configurations.",
      });
    }
    if (
      target.configurations.some(
        (configuration) => configuration.entitlementsPath.state !== "resolved",
      )
    ) {
      blockers.push({
        code: "unresolved-entitlements-path",
        message: "Resolve CODE_SIGN_ENTITLEMENTS for every selected-target configuration.",
      });
    }
    if (target.configurations.some((configuration) => configuration.entitlements == null)) {
      blockers.push({
        code: "missing-or-unreadable-entitlements",
        message: "Every selected-target configuration must use an existing XML entitlements file.",
      });
    }
    if (
      target.configurations.some(
        (configuration) =>
          (configuration.entitlements?.unresolvedAssociatedDomains.length ?? 0) > 0,
      )
    ) {
      blockers.push({
        code: "unresolved-associated-domains",
        message: "Resolve existing associated-domain build variables before editing entitlements.",
      });
    }
  }

  if (!expectedDomain && associatedDomainPlan?.requiresPublishableKey !== true) {
    blockers.push({
      code: "expected-domain-unavailable",
      message: "A proven local publishable key is required to derive the webcredentials domain.",
    });
  }
  if (inspection.generatedProject !== null) {
    blockers.push({
      code: "generated-project",
      message: `The Xcode project is owned by ${inspection.generatedProject}; update its source definition instead.`,
    });
  }
  if (status === "review") {
    blockers.push({
      code: "manual-review-required",
      message: "The canonical iOS setup plan requires review before this domain can be edited.",
    });
  }

  const strictPlanBlockers =
    associatedDomainPlan?.blockers.map((item) => ({
      code: "manual-review-required" as const,
      message: item.message,
    })) ?? [];
  const plannedExpectedDomain =
    associatedDomainPlan?.requiresPublishableKey === true
      ? undefined
      : (associatedDomainPlan?.expectedDomain ?? expectedDomain);
  return {
    status,
    expectedDomain: plannedExpectedDomain,
    files,
    automatable:
      associatedDomainPlan != null
        ? associatedDomainPlan.status === "ready" && strictPlanBlockers.length === 0
        : status === "required" && blockers.length === 0,
    blockers: [...strictPlanBlockers, ...blockers],
  };
}

/**
 * Builds a synchronous, serializable readiness snapshot without authentication,
 * network access, or filesystem writes. Publishable-key values are never copied.
 */
export function buildIOSNativeReadinessAudit(
  inspection: IOSProjectInspectionResult,
  options: BuildIOSNativeReadinessAuditOptions = {},
): IOSNativeReadinessAudit {
  const target = selectedTarget(inspection);
  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-readiness",
    root: inspection.root,
    target: targetIdentity(inspection, target),
    associatedDomain: associatedDomainReadiness(inspection, target, options.associatedDomainPlan),
    remote: {
      status: "not-inspected",
      reason: "dry-run-does-not-read-remote-state",
      requirement: IOS_NATIVE_READINESS_PLAPI_BRIDGE_REQUIREMENT,
    },
  };
}
