import type { IOSAppTarget, IOSProjectInspectionResult } from "./types.ts";

export type ClerkKitUIInstallDecision = "prebuilt" | "core-only" | "unknown";

/**
 * Chooses the prebuilt UI product for an explicitly UI-backed target or for a
 * fully inspected target that has not begun a custom Clerk integration. A
 * source-blank ClerkKit-only graph is upgraded because an earlier CLI release
 * may have created it; source-proven custom targets remain core-only.
 */
export function clerkKitUIInstallDecision(target: IOSAppTarget): ClerkKitUIInstallDecision {
  const hasUIIntent =
    target.swift.importsClerkKitUI.length > 0 || target.packages.clerkKitUI !== "absent";
  if (hasUIIntent) return "prebuilt";

  const hasCustomSourceIntent = target.swift.importsClerkKit.length > 0;
  if (!target.swift.evidenceComplete) return "unknown";
  return hasCustomSourceIntent ? "core-only" : "prebuilt";
}

export function shouldInstallClerkKitUI(target: IOSAppTarget): boolean {
  return clerkKitUIInstallDecision(target) === "prebuilt";
}

export function hasIOSProvenStartupKeyWiring(
  target: IOSAppTarget,
  wiring: "local-secrets-loader" | "process-info-environment",
): boolean {
  return target.swift.configureCalls.some(
    (call) =>
      call.startupBinding === "app-init" &&
      call.publishableKeyWiring === wiring &&
      (wiring !== "local-secrets-loader" || call.localSecretsRuntimeBinding === "proven"),
  );
}

/** Existing runtime-key routes that direct source configuration must preserve. */
export function hasIOSDirectConfigCompatibility(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
): boolean {
  // Preserve the inspection parameter for callers that make this decision
  // from a complete inspection, but never infer runtime wiring from artifacts.
  void inspection;
  return (
    hasIOSProvenStartupKeyWiring(target, "local-secrets-loader") ||
    hasIOSProvenStartupKeyWiring(target, "process-info-environment")
  );
}

/**
 * Routes only the fresh/direct-literal Swift path to the source mutator.
 * Existing LocalSecrets and ProcessInfo integrations remain compatibility
 * paths and are never rewritten into a literal automatically.
 */
export function shouldPlanIOSDirectConfig(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
  productDecision: ClerkKitUIInstallDecision = clerkKitUIInstallDecision(target),
): boolean {
  if (hasIOSDirectConfigCompatibility(inspection, target)) return false;

  const hasInlineConfigure = target.swift.configureCalls.some(
    (call) => call.publishableKeyWiring === "inline-literal",
  );
  return (
    hasInlineConfigure || target.swift.configureCalls.length > 0 || productDecision === "prebuilt"
  );
}
