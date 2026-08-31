import type { IOSProjectInspectionResult, IOSSetupPlan, IOSSetupStepStatus } from "./types.ts";
import { buildIOSNativeReadinessAudit, type IOSNativeReadinessAudit } from "./native-readiness.ts";
import type { IOSAssociatedDomainPlan } from "./associated-domain.ts";
import { hasSupportedIOSCustomConfigure } from "./products.ts";

const STATUS_MARKER: Record<IOSSetupStepStatus, string> = {
  satisfied: "✓",
  required: "○",
  review: "!",
  blocked: "×",
};

export interface IOSDryRunOutput {
  schemaVersion: 1;
  mode: "read-only";
  status: IOSSetupPlan["status"];
  inspection: IOSProjectInspectionResult;
  plan: IOSSetupPlan;
  nativeReadiness: IOSNativeReadinessAudit;
}

export interface IOSOutputOptions {
  associatedDomainPlan?: IOSAssociatedDomainPlan;
  /** Exact readiness audit from the shared local setup proposal. */
  nativeReadiness?: IOSNativeReadinessAudit;
}

export function createIOSDryRunOutput(
  inspection: IOSProjectInspectionResult,
  plan: IOSSetupPlan,
  options: IOSOutputOptions = {},
): IOSDryRunOutput {
  return {
    schemaVersion: 1,
    mode: "read-only",
    status: plan.status,
    inspection,
    plan,
    nativeReadiness: options.nativeReadiness ?? buildIOSNativeReadinessAudit(inspection, options),
  };
}

export function formatIOSSetupPlan(
  inspection: IOSProjectInspectionResult,
  plan: IOSSetupPlan,
  options: IOSOutputOptions = {},
): string {
  const lines = ["", "iOS setup plan (read-only)", `  Root: ${inspection.root}`];

  if (inspection.selection.state === "selected") {
    lines.push(
      `  Target: ${inspection.selection.targetName} (${inspection.selection.projectPath})`,
    );
  } else if (inspection.selection.state === "ambiguous") {
    lines.push("  Targets:");
    for (const candidate of inspection.selection.candidates) {
      lines.push(
        `    - ${candidate.targetName} [${candidate.targetId}] in ${candidate.projectPath}`,
      );
    }
  }

  const selection = inspection.selection;
  const selected =
    selection.state === "selected"
      ? inspection.appTargets.find(
          (target) =>
            target.id === selection.targetId && target.projectPath === selection.projectPath,
        )
      : undefined;
  if (selected) {
    const bundles = [
      ...new Set(
        selected.configurations.flatMap((configuration) =>
          configuration.bundleIdentifier.state === "resolved"
            ? [configuration.bundleIdentifier.value]
            : [],
        ),
      ),
    ];
    if (bundles.length > 0) lines.push(`  Bundle ID: ${bundles.join(", ")}`);
    lines.push(
      `  ClerkKit: ${selected.packages.clerkKit}; ClerkKitUI: ${selected.packages.clerkKitUI}`,
    );
  }
  const localPublishableKey = inspection.localPublishableKey;
  if (localPublishableKey.state === "valid") {
    lines.push(
      `  Publishable key: found (${localPublishableKey.instanceType}; ${localPublishableKey.frontendApiHost})`,
    );
  } else if (selected && hasSupportedIOSCustomConfigure(selected)) {
    lines.push("  Publishable key: custom source (value not inspected)");
  } else {
    const keyStatus =
      localPublishableKey.state === "invalid"
        ? "invalid inline key"
        : localPublishableKey.state === "unproven"
          ? "configuration needs review (value not inspected)"
          : "not found";
    lines.push(`  Publishable key: ${keyStatus}`);
  }

  lines.push("");
  for (const item of plan.steps) {
    lines.push(`  ${STATUS_MARKER[item.status]} [${item.status}] ${item.title}`);
    lines.push(`      ${item.description}`);
    if (item.automatable) lines.push("      `clerk init` can apply this step.");
    for (const link of item.links ?? []) lines.push(`      ${link.url}`);
  }

  if (plan.diagnostics.length > 0) {
    lines.push("", "  Diagnostics:");
    for (const diagnostic of plan.diagnostics) {
      lines.push(`    - [${diagnostic.severity}] ${diagnostic.code}: ${diagnostic.message}`);
      if (diagnostic.remedy) lines.push(`      ${diagnostic.remedy}`);
    }
  }

  const nativeReadiness =
    options.nativeReadiness ?? buildIOSNativeReadinessAudit(inspection, options);
  lines.push("", "  Native iOS readiness:");
  lines.push(
    `    - Associated Domains: ${nativeReadiness.associatedDomain.status}${nativeReadiness.associatedDomain.automatable ? " (clerk init can apply)" : ""}`,
  );
  if (!nativeReadiness.associatedDomain.automatable) {
    for (const blocker of nativeReadiness.associatedDomain.blockers) {
      lines.push(`      ${blocker.message}`);
    }
  }
  lines.push(
    "    - Native API and Dashboard iOS registration: not inspected during this local-only dry-run. Regular `clerk init` audits and safely reconciles both on the linked development instance after authentication.",
  );

  lines.push(
    "",
    "  No files, Xcode settings, Clerk applications, or remote resources were changed.",
  );
  return lines.join("\n");
}
