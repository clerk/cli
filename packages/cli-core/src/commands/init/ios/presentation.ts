import { isHuman } from "../../../mode.ts";
import { dim, yellow } from "../../../lib/color.ts";
import { getLogLevel, log } from "../../../lib/log.ts";
import { withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import type { IOSLocalSetupProposal } from "./local-plan.ts";

export function compactNativeOutput(): boolean {
  return isHuman() && getLogLevel() !== "debug";
}

/** Routine checks stay visible while running; verbose mode retains their history. */
export async function withNativeSpinner<T>(
  message: string,
  fn: (controls: SpinnerControls) => Promise<T>,
): Promise<T> {
  return withSpinner(message, fn, compactNativeOutput() ? null : undefined);
}

/** Summarize the approved plans without changing their actions or prerequisites. */
export function printNativeLocalPreview(
  proposal: IOSLocalSetupProposal,
  projectFile: string,
): void {
  const rows = new Map<string, { operation: string; details: Set<string> }>();
  const add = (path: string, operation: string, detail: string) => {
    const row = rows.get(path) ?? { operation, details: new Set<string>() };
    if (operation === "CREATE") row.operation = operation;
    row.details.add(detail);
    rows.set(path, row);
  };
  const sdk = proposal.installPlan;
  if (sdk?.status === "ready") {
    add(projectFile, "UPDATE", `Link ${sdk.products.join(" and ")}`);
  }
  const direct = proposal.directConfigPlan;
  if (direct?.sourcePath && direct.changes) {
    const changes = direct.changes;
    const writes =
      changes.clerkKitImport === "insert" ||
      changes.configuration !== "verify-existing" ||
      changes.environment === "insert";
    const operation = writes ? "UPDATE" : "VERIFY";
    add(
      direct.sourcePath,
      operation,
      changes.configuration === "verify-existing"
        ? "Verify the existing configuration matches the linked development app"
        : "Configure Clerk with your development publishable key",
    );
    if (changes.environment === "insert") {
      add(direct.sourcePath, operation, "Make Clerk available to your SwiftUI views");
    }
  }
  const ui = proposal.prebuiltAuthPlan;
  if (ui?.sourcePath) {
    add(
      ui.sourcePath,
      ui.status === "ready" ? "UPDATE" : "VERIFY",
      ui.status === "ready"
        ? "Replace the starter screen with sign-in and account UI"
        : "Keep the existing Clerk sign-in UI",
    );
  }
  const capability = (
    plan:
      | IOSLocalSetupProposal["appleEntitlementPlan"]
      | IOSLocalSetupProposal["associatedDomainPlan"]
      | IOSLocalSetupProposal["macOSNetworkCapabilityPlan"],
    description: string,
    conditional = false,
  ) => {
    if (plan?.status !== "ready") return;
    if (plan.missingEntitlementsSettings) {
      add(
        projectFile,
        "UPDATE",
        conditional
          ? "Attach entitlements if Apple sign-in is enabled for the linked app"
          : "Attach the selected target’s entitlements",
      );
    }
    for (const file of plan.files) {
      add(file.path, file.operation === "create" ? "CREATE" : "UPDATE", description);
    }
  };
  capability(proposal.associatedDomainPlan, "Add Clerk’s Associated Domain");
  capability(proposal.macOSNetworkCapabilityPlan, "Allow outgoing network connections");
  capability(proposal.appleEntitlementPlan, "Add the Sign in with Apple entitlement");
  if (proposal.prebuiltAuthAppleEntitlementPlan !== proposal.appleEntitlementPlan) {
    capability(
      proposal.prebuiltAuthAppleEntitlementPlan,
      "Add the Apple entitlement only if Apple sign-in is enabled for the linked app",
      true,
    );
  }
  if (rows.size > 0) {
    const target = proposal.nativeReadiness.target;
    if (target.status === "selected" && target.bundleIdentifier.status === "resolved") {
      log.info(dim(`Bundle ID: ${target.bundleIdentifier.value}`));
    }
    log.info(
      [...rows.values()].some((row) => row.operation !== "VERIFY")
        ? "\nLocal changes:\n"
        : "\nLocal checks:\n",
    );
    for (const [path, row] of rows) {
      log.info(`  ${yellow(row.operation)}  ${path}`);
      for (const detail of row.details) log.info(`          ${detail}`);
    }
  } else {
    log.info("No local file changes planned.");
  }
  log.info(
    dim("\nClerk settings will be reviewed separately. Use --verbose for implementation details."),
  );
  log.blank();
}
