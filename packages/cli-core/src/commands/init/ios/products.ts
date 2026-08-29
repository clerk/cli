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

/**
 * A custom publishable-key source is structurally usable only when the
 * selected app has one unambiguous configure call at startup. The expression
 * itself remains opaque and is never inspected or compared.
 */
export function hasSupportedIOSCustomConfigure(target: IOSAppTarget): boolean {
  const configureCalls = target.swift.configureCalls;
  return (
    target.swift.evidenceComplete &&
    target.swift.status !== "ambiguous" &&
    configureCalls.length === 1 &&
    configureCalls[0]?.publishableKeyWiring === "custom" &&
    configureCalls[0].startupBinding === "app-init"
  );
}

/** Existing custom configuration that direct source setup must preserve. */
export function hasIOSDirectConfigCompatibility(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
): boolean {
  // A custom expression belongs to the developer. Its value and loading
  // strategy are deliberately not interpreted by the inspector.
  void inspection;
  return target.swift.configureCalls.some((call) => call.publishableKeyWiring === "custom");
}

/**
 * Routes only the fresh/direct-literal Swift path to the source mutator.
 * Existing custom integrations remain compatibility paths and are never
 * rewritten into a literal automatically.
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
