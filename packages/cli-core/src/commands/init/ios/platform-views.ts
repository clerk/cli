import { normalizeBundleIdentifierIdentity } from "../../../lib/apple-native-identity.ts";
import { hasIncompleteIOSContainerDiscovery, inspectIOSProject } from "./inspect.ts";
import { clerkKitUIInstallDecision, type ClerkKitUIInstallDecision } from "./products.ts";
import type {
  IOSAppTarget,
  IOSConfigureCallEvidence,
  IOSNativePlatform,
  IOSProjectInspectionResult,
  IOSSourceEvidence,
  IOSSwiftInspection,
} from "./types.ts";

const NATIVE_PLATFORMS = ["ios", "macos"] as const;

export type IOSPlatformViewInspector = typeof inspectIOSProject;

export type IOSPlatformViewBlockerCode =
  | "target-not-selected"
  | "incomplete-container-discovery"
  | "platform-inspection-failed"
  | "target-changed"
  | "supported-platforms-changed"
  | "unresolved-platform"
  | "incomplete-swift-evidence"
  | "unresolved-bundle-identifier"
  | "conflicting-bundle-identifier"
  | "conflicting-app-id-prefix"
  | "divergent-app-root"
  | "divergent-swift-semantics";

export interface IOSPlatformViewBlocker {
  code: IOSPlatformViewBlockerCode;
  platform?: IOSNativePlatform;
  message: string;
}

interface RedactedSourceEvidence {
  path: string;
  objectId?: string;
  keyPath?: string;
}

interface RedactedConfigureCall extends RedactedSourceEvidence {
  publishableKeyWiring: IOSConfigureCallEvidence["publishableKeyWiring"];
  startupBinding: IOSConfigureCallEvidence["startupBinding"];
  inlinePublishableKey?:
    | { state: "invalid" }
    | {
        state: "valid";
        frontendApiHost: string;
        instanceType: "development" | "production";
      };
}

/**
 * Clerk-relevant Swift evidence for one conditioned platform view. Raw source,
 * publishable keys, file counts, and unrelated target members are omitted.
 */
export interface IOSPlatformSwiftSnapshot {
  evidenceComplete: boolean;
  status: IOSSwiftInspection["status"];
  entryPoints: RedactedSourceEvidence[];
  importsClerkKit: RedactedSourceEvidence[];
  importsClerkKitUI: RedactedSourceEvidence[];
  configureCalls: RedactedConfigureCall[];
  appRootEvidence: RedactedSourceEvidence[];
  environmentInjections: RedactedSourceEvidence[];
  rootEnvironmentInjections: RedactedSourceEvidence[];
  environmentConsumers: RedactedSourceEvidence[];
  authViewReferences: RedactedSourceEvidence[];
  authFlowReferences: RedactedSourceEvidence[];
  appleAuthReferences: RedactedSourceEvidence[];
}

export interface IOSPlatformTargetViewSnapshot {
  platform: IOSNativePlatform;
  productDecision: ClerkKitUIInstallDecision;
  swift: IOSPlatformSwiftSnapshot;
}

/**
 * Canonical, secret-free evidence that can be stored with an approved plan and
 * compared against a later exhaustive inspection before local or remote writes.
 */
export interface IOSPlatformViewsSnapshot {
  schemaVersion: 1;
  kind: "clerk-ios-platform-views";
  root: string;
  projectPath: string;
  targetId: string;
  primaryPlatform: IOSNativePlatform;
  supportedPlatforms: IOSNativePlatform[];
  /** ASCII case-insensitive Apple Bundle ID identity. */
  bundleIdentifier: string;
  /** Exact literal entitlement evidence, when one unambiguous value exists. */
  appIdPrefix?: string;
  productDecision: ClerkKitUIInstallDecision;
  requiresClerkKitUI: boolean;
  requiresAuthViewCompatibility: boolean;
  /** Present only when every platform ships the same sole @main source. */
  sharedEntryPointPath: string | null;
  /** Present only when every platform proves the same sole SwiftUI app root. */
  sharedAppRootPath: string | null;
  platforms: IOSPlatformTargetViewSnapshot[];
}

export type IOSPlatformViewsAudit =
  | { status: "ready"; snapshot: IOSPlatformViewsSnapshot }
  | { status: "blocked"; blockers: IOSPlatformViewBlocker[] };

function canonicalPlatforms(platforms: readonly IOSNativePlatform[]): IOSNativePlatform[] {
  const values = new Set(platforms);
  return NATIVE_PLATFORMS.filter((platform) => values.has(platform));
}

function samePlatforms(
  left: readonly IOSNativePlatform[],
  right: readonly IOSNativePlatform[],
): boolean {
  const canonicalLeft = canonicalPlatforms(left);
  const canonicalRight = canonicalPlatforms(right);
  return (
    canonicalLeft.length === canonicalRight.length &&
    canonicalLeft.every((platform, index) => platform === canonicalRight[index])
  );
}

function selectedTarget(inspection: IOSProjectInspectionResult): IOSAppTarget | undefined {
  const selection = inspection.selection;
  if (selection.state !== "selected") return undefined;
  return inspection.appTargets.find(
    (target) => target.id === selection.targetId && target.projectPath === selection.projectPath,
  );
}

function evidenceKey(evidence: RedactedSourceEvidence): string {
  return `${evidence.path}\0${evidence.objectId ?? ""}\0${evidence.keyPath ?? ""}`;
}

function redactEvidence(evidence: IOSSourceEvidence): RedactedSourceEvidence {
  return {
    path: evidence.path,
    ...(evidence.objectId ? { objectId: evidence.objectId } : {}),
    ...(evidence.keyPath ? { keyPath: evidence.keyPath } : {}),
  };
}

function redactedEvidence(values: readonly IOSSourceEvidence[]): RedactedSourceEvidence[] {
  return values
    .map(redactEvidence)
    .sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)));
}

function redactedConfigureCalls(
  values: readonly IOSConfigureCallEvidence[],
): RedactedConfigureCall[] {
  return values
    .map((call): RedactedConfigureCall => ({
      ...redactEvidence(call),
      publishableKeyWiring: call.publishableKeyWiring,
      startupBinding: call.startupBinding,
      ...(call.inlinePublishableKey
        ? call.inlinePublishableKey.state === "valid"
          ? {
              inlinePublishableKey: {
                state: "valid",
                frontendApiHost: call.inlinePublishableKey.frontendApiHost,
                instanceType: call.inlinePublishableKey.instanceType,
              },
            }
          : { inlinePublishableKey: { state: "invalid" } }
        : {}),
    }))
    .sort((left, right) => {
      const evidenceOrder = evidenceKey(left).localeCompare(evidenceKey(right));
      if (evidenceOrder !== 0) return evidenceOrder;
      return `${left.publishableKeyWiring}\0${left.startupBinding}`.localeCompare(
        `${right.publishableKeyWiring}\0${right.startupBinding}`,
      );
    });
}

function swiftSnapshot(swift: IOSSwiftInspection): IOSPlatformSwiftSnapshot {
  return {
    evidenceComplete: swift.evidenceComplete,
    status: swift.status,
    entryPoints: redactedEvidence(swift.entryPoints),
    importsClerkKit: redactedEvidence(swift.importsClerkKit),
    importsClerkKitUI: redactedEvidence(swift.importsClerkKitUI),
    configureCalls: redactedConfigureCalls(swift.configureCalls),
    appRootEvidence: redactedEvidence(swift.appRootEvidence),
    environmentInjections: redactedEvidence(swift.environmentInjections),
    rootEnvironmentInjections: redactedEvidence(swift.rootEnvironmentInjections),
    environmentConsumers: redactedEvidence(swift.environmentConsumers),
    authViewReferences: redactedEvidence(swift.authViewReferences),
    authFlowReferences: redactedEvidence(swift.authFlowReferences),
    appleAuthReferences: redactedEvidence(swift.appleAuthReferences),
  };
}

interface ClerkSwiftSemanticSignature {
  status: IOSSwiftInspection["status"];
  productDecision: ClerkKitUIInstallDecision;
  configureCalls: Array<
    Pick<RedactedConfigureCall, "publishableKeyWiring" | "startupBinding" | "inlinePublishableKey">
  >;
  hasRootEnvironmentInjection: boolean;
  hasEnvironmentConsumer: boolean;
  hasAuthView: boolean;
  hasAuthenticationFlow: boolean;
  hasNativeAppleFlow: boolean;
}

/**
 * Compares only evidence that changes Clerk setup decisions. Evidence paths,
 * unrelated target members, and URL/callback listeners deliberately do not
 * participate: those listeners are optional integration details rather than
 * prerequisites for the basic setup this audit protects.
 */
function clerkSwiftSemanticSignature(
  view: IOSPlatformTargetViewSnapshot,
): ClerkSwiftSemanticSignature {
  return {
    status: view.swift.status,
    productDecision: view.productDecision,
    configureCalls: view.swift.configureCalls
      .map((call) => ({
        publishableKeyWiring: call.publishableKeyWiring,
        startupBinding: call.startupBinding,
        ...(call.inlinePublishableKey ? { inlinePublishableKey: call.inlinePublishableKey } : {}),
      }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    hasRootEnvironmentInjection: view.swift.rootEnvironmentInjections.length > 0,
    hasEnvironmentConsumer: view.swift.environmentConsumers.length > 0,
    hasAuthView: view.swift.authViewReferences.length > 0,
    hasAuthenticationFlow: view.swift.authFlowReferences.length > 0,
    hasNativeAppleFlow: view.swift.appleAuthReferences.length > 0,
  };
}

function evidencePaths(values: readonly RedactedSourceEvidence[]): string[] {
  return [...new Set(values.map((value) => value.path))].sort();
}

function allViewsHaveSamePaths(
  views: readonly IOSPlatformTargetViewSnapshot[],
  select: (swift: IOSPlatformSwiftSnapshot) => readonly RedactedSourceEvidence[],
): boolean {
  const first = JSON.stringify(evidencePaths(select(views[0]!.swift)));
  return views.every((view) => JSON.stringify(evidencePaths(select(view.swift))) === first);
}

function soleSharedPath(
  views: readonly IOSPlatformTargetViewSnapshot[],
  select: (swift: IOSPlatformSwiftSnapshot) => readonly RedactedSourceEvidence[],
): string | null {
  const paths = views.map((view) => {
    const evidence = select(view.swift);
    return evidence.length === 1 ? evidence[0]?.path : undefined;
  });
  const first = paths[0];
  return first && paths.every((path) => path === first) ? first : null;
}

function bundleIdentifierIdentity(
  target: IOSAppTarget,
): { status: "resolved"; value: string } | { status: "missing" | "conflicting" } {
  if (
    target.configurations.length === 0 ||
    target.configurations.some(
      (configuration) => configuration.bundleIdentifier.state !== "resolved",
    )
  ) {
    return { status: "missing" };
  }
  const values = new Set(
    target.configurations.map((configuration) =>
      normalizeBundleIdentifierIdentity(
        (
          configuration.bundleIdentifier as Extract<
            typeof configuration.bundleIdentifier,
            { state: "resolved" }
          >
        ).value,
      ),
    ),
  );
  return values.size === 1
    ? { status: "resolved", value: [...values][0]! }
    : { status: "conflicting" };
}

function literalAppIdPrefixes(target: IOSAppTarget): string[] {
  return [
    ...new Set(
      target.configurations
        .map((configuration) => configuration.entitlements?.literalAppIdentifierPrefix)
        .filter((value): value is string => value != null),
    ),
  ].sort();
}

function aggregateProductDecision(
  views: readonly IOSPlatformTargetViewSnapshot[],
): ClerkKitUIInstallDecision {
  if (views.some((view) => view.productDecision === "unknown")) return "unknown";
  return views.some((view) => view.productDecision === "prebuilt") ? "prebuilt" : "core-only";
}

/**
 * Exhaustively inspects every modeled iOS/macOS view of one selected Xcode
 * target and returns a deterministic, redacted semantic snapshot.
 */
export async function inspectIOSPlatformViews(
  primaryInspection: IOSProjectInspectionResult,
  inspector: IOSPlatformViewInspector = inspectIOSProject,
): Promise<IOSPlatformViewsAudit> {
  const primaryTarget = selectedTarget(primaryInspection);
  if (!primaryTarget || primaryInspection.selection.state !== "selected") {
    return {
      status: "blocked",
      blockers: [
        {
          code: "target-not-selected",
          message:
            "One native Apple application target must be selected before inspecting platform views.",
        },
      ],
    };
  }

  const supportedPlatforms = canonicalPlatforms(primaryTarget.supportedPlatforms);
  if (
    supportedPlatforms.length === 0 ||
    !supportedPlatforms.includes(primaryTarget.platform) ||
    !primaryTarget.platformEvidenceComplete
  ) {
    return {
      status: "blocked",
      blockers: [
        {
          code: "unresolved-platform",
          platform: primaryTarget.platform,
          message: "The selected target's native Apple platform support is unresolved.",
        },
      ],
    };
  }

  const inspections = await Promise.all(
    supportedPlatforms.map(async (platform) => {
      try {
        return {
          platform,
          inspection: await inspector(primaryInspection.root, {
            target: primaryTarget.id,
            platform,
            exhaustiveContainerDiscovery: true,
          }),
        } as const;
      } catch {
        return { platform, inspection: undefined } as const;
      }
    }),
  );

  const blockers: IOSPlatformViewBlocker[] = [];
  const targets: Array<{ platform: IOSNativePlatform; target: IOSAppTarget }> = [];
  for (const view of inspections) {
    if (!view.inspection) {
      blockers.push({
        code: "platform-inspection-failed",
        platform: view.platform,
        message: `The ${view.platform === "macos" ? "macOS" : "iOS"} target view could not be inspected safely.`,
      });
      continue;
    }
    if (hasIncompleteIOSContainerDiscovery(view.inspection)) {
      blockers.push({
        code: "incomplete-container-discovery",
        platform: view.platform,
        message: `Exhaustive Xcode container discovery was incomplete for the ${view.platform === "macos" ? "macOS" : "iOS"} target view.`,
      });
      continue;
    }
    const selection = view.inspection.selection;
    const target = selectedTarget(view.inspection);
    if (
      selection.state !== "selected" ||
      selection.targetId !== primaryTarget.id ||
      selection.projectPath !== primaryTarget.projectPath ||
      selection.platform !== view.platform ||
      !target ||
      target.id !== primaryTarget.id ||
      target.projectPath !== primaryTarget.projectPath ||
      target.platform !== view.platform
    ) {
      blockers.push({
        code: "target-changed",
        platform: view.platform,
        message: `The forced ${view.platform === "macos" ? "macOS" : "iOS"} inspection did not select the approved Xcode target.`,
      });
      continue;
    }
    if (!samePlatforms(target.supportedPlatforms, supportedPlatforms)) {
      blockers.push({
        code: "supported-platforms-changed",
        platform: view.platform,
        message: "The selected target's supported native Apple platforms changed between views.",
      });
      continue;
    }
    if (!target.platformEvidenceComplete) {
      blockers.push({
        code: "unresolved-platform",
        platform: view.platform,
        message: `The ${view.platform === "macos" ? "macOS" : "iOS"} target view has unresolved platform evidence.`,
      });
      continue;
    }
    if (!target.swift.evidenceComplete) {
      blockers.push({
        code: "incomplete-swift-evidence",
        platform: view.platform,
        message: `Clerk-relevant Swift source membership could not be inspected completely for the ${view.platform === "macos" ? "macOS" : "iOS"} target view.`,
      });
      continue;
    }
    targets.push({ platform: view.platform, target });
  }
  if (blockers.length > 0) return { status: "blocked", blockers };

  const bundleIdentities = targets.map(({ platform, target }) => ({
    platform,
    identity: bundleIdentifierIdentity(target),
  }));
  for (const value of bundleIdentities) {
    if (value.identity.status === "missing") {
      blockers.push({
        code: "unresolved-bundle-identifier",
        platform: value.platform,
        message: `The ${value.platform === "macos" ? "macOS" : "iOS"} target view does not have one resolved Bundle ID across its build configurations.`,
      });
    } else if (value.identity.status === "conflicting") {
      blockers.push({
        code: "conflicting-bundle-identifier",
        platform: value.platform,
        message: `The ${value.platform === "macos" ? "macOS" : "iOS"} target view has conflicting Bundle IDs across its build configurations.`,
      });
    }
  }
  const resolvedBundleIdentities = bundleIdentities.flatMap(({ identity }) =>
    identity.status === "resolved" ? [identity.value] : [],
  );
  if (new Set(resolvedBundleIdentities).size > 1) {
    blockers.push({
      code: "conflicting-bundle-identifier",
      message:
        "The selected target resolves to different Bundle IDs across its supported platforms.",
    });
  }

  const prefixes = [
    ...new Set(targets.flatMap(({ target }) => literalAppIdPrefixes(target))),
  ].sort();
  if (prefixes.length > 1) {
    blockers.push({
      code: "conflicting-app-id-prefix",
      message: "The selected target contains conflicting literal Apple App ID Prefix evidence.",
    });
  }
  if (blockers.length > 0) return { status: "blocked", blockers };

  const platformSnapshots = targets
    .map(({ platform, target }): IOSPlatformTargetViewSnapshot => ({
      platform,
      productDecision: clerkKitUIInstallDecision(target),
      swift: swiftSnapshot(target.swift),
    }))
    .sort(
      (left, right) =>
        NATIVE_PLATFORMS.indexOf(left.platform) - NATIVE_PLATFORMS.indexOf(right.platform),
    );
  const productDecision = aggregateProductDecision(platformSnapshots);
  if (
    !allViewsHaveSamePaths(platformSnapshots, (swift) => swift.entryPoints) ||
    !allViewsHaveSamePaths(platformSnapshots, (swift) => swift.appRootEvidence)
  ) {
    return {
      status: "blocked",
      blockers: [
        {
          code: "divergent-app-root",
          message:
            "The selected target uses different Swift application roots across its supported platforms.",
        },
      ],
    };
  }
  const semanticSignatures = platformSnapshots.map(clerkSwiftSemanticSignature);
  if (
    semanticSignatures.some(
      (signature) => JSON.stringify(signature) !== JSON.stringify(semanticSignatures[0]),
    )
  ) {
    return {
      status: "blocked",
      blockers: [
        {
          code: "divergent-swift-semantics",
          message:
            "The selected target has different Clerk setup semantics across its supported platforms.",
        },
      ],
    };
  }
  const snapshot: IOSPlatformViewsSnapshot = {
    schemaVersion: 1,
    kind: "clerk-ios-platform-views",
    root: primaryInspection.root,
    projectPath: primaryTarget.projectPath,
    targetId: primaryTarget.id,
    primaryPlatform: primaryTarget.platform,
    supportedPlatforms,
    bundleIdentifier: resolvedBundleIdentities[0]!,
    ...(prefixes[0] ? { appIdPrefix: prefixes[0] } : {}),
    productDecision,
    requiresClerkKitUI: productDecision === "prebuilt",
    requiresAuthViewCompatibility: platformSnapshots.some(
      (view) => view.swift.authViewReferences.length > 0,
    ),
    sharedEntryPointPath: soleSharedPath(platformSnapshots, (swift) => swift.entryPoints),
    sharedAppRootPath: soleSharedPath(platformSnapshots, (swift) => swift.appRootEvidence),
    platforms: platformSnapshots,
  };
  return { status: "ready", snapshot };
}

export function iosPlatformViewsSnapshotsEqual(
  left: IOSPlatformViewsSnapshot,
  right: IOSPlatformViewsSnapshot,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/**
 * Rebuilds the exhaustive platform snapshot from the approved target. This is
 * intentionally read-only and is used immediately before local or remote
 * mutation boundaries.
 */
export async function reinspectIOSPlatformViews(
  approved: IOSPlatformViewsSnapshot,
  inspector: IOSPlatformViewInspector = inspectIOSProject,
): Promise<IOSPlatformViewsAudit> {
  let primary: IOSProjectInspectionResult;
  try {
    primary = await inspector(approved.root, {
      target: approved.targetId,
      platform: approved.primaryPlatform,
      exhaustiveContainerDiscovery: true,
    });
  } catch {
    return {
      status: "blocked",
      blockers: [
        {
          code: "platform-inspection-failed",
          platform: approved.primaryPlatform,
          message: "The approved native Apple target could not be re-inspected safely.",
        },
      ],
    };
  }
  return inspectIOSPlatformViews(primary, inspector);
}

/**
 * Swift setup may intentionally change during a local transaction. Remote
 * reconciliation therefore compares only the stable target and Apple identity
 * fields, while the pre-write check uses full snapshot equality.
 */
export function iosPlatformViewsIdentityMatches(
  approved: IOSPlatformViewsSnapshot,
  current: IOSPlatformViewsSnapshot,
): boolean {
  return (
    approved.root === current.root &&
    approved.projectPath === current.projectPath &&
    approved.targetId === current.targetId &&
    approved.primaryPlatform === current.primaryPlatform &&
    samePlatforms(approved.supportedPlatforms, current.supportedPlatforms) &&
    approved.bundleIdentifier === current.bundleIdentifier &&
    approved.appIdPrefix === current.appIdPrefix
  );
}
