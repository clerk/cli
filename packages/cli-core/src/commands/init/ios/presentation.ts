import { AsyncLocalStorage } from "node:async_hooks";
import { isHuman } from "../../../mode.ts";
import { dim, yellow } from "../../../lib/color.ts";
import { getLogLevel, log } from "../../../lib/log.ts";
import { createSpinner, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";
import type { IOSLocalSetupProposal } from "./local-plan.ts";

export function compactNativeOutput(): boolean {
  return isHuman() && getLogLevel() !== "debug";
}

const progress = new AsyncLocalStorage<{
  message: string;
  spinner?: ReturnType<typeof createSpinner>;
}>();

/** Keep one indicator across sequential checks; always clean up on command exit. */
export async function withNativeProgress<T>(fn: () => Promise<T>): Promise<T> {
  if (!compactNativeOutput()) return fn();
  return progress.run({ message: "Inspecting your project..." }, async () => {
    try {
      return await fn();
    } catch (error) {
      progress.getStore()?.spinner?.fail(error);
      throw error;
    } finally {
      stopNativeProgress();
    }
  });
}

/** Call before displaying a question, preview, or result. */
export function stopNativeProgress(): void {
  const state = progress.getStore();
  state?.spinner?.stop();
  if (state) state.spinner = undefined;
}

export function setNativeProgressPhase(message: string): void {
  const state = progress.getStore();
  if (!state || state.message === message) return;
  stopNativeProgress();
  state.message = message;
}

/** In compact init, individual checks share the phase's stable label and spinner. */
export async function withNativeSpinner<T>(
  message: string,
  fn: (controls: SpinnerControls) => Promise<T>,
): Promise<T> {
  const state = progress.getStore();
  if (state) {
    state.spinner ??= createSpinner(state.message, null);
    return fn({ update: () => {} });
  }
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
