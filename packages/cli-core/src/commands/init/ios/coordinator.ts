import type { InitOptions } from "../index.ts";
import { confirm, text } from "../../../lib/prompts.ts";
import { select } from "../../../lib/listage.ts";
import { log } from "../../../lib/log.ts";
import {
  ApiError,
  CliError,
  ERROR_CODE,
  throwUsageError,
  throwUserAbort,
} from "../../../lib/errors.ts";
import { interruptSignal } from "../../../lib/signals.ts";
import { outro } from "../../../lib/spinner.ts";
import { stopNativeProgress, withNativeSpinner } from "./progress.ts";
import { isUnchangedStarter } from "./starter.ts";
import { planAppleSetup } from "./plan.ts";
import { inspectSelectedProject } from "./xcode.ts";
import { SelectionNeeded } from "./discovery.ts";
import { IdentityRequired, describeIdentity } from "./identity.ts";
import {
  applySetup,
  describePreview,
  prepareSetup,
  type ApplyResult,
  type Dependencies,
  type SetupOptions,
  type SetupPreview,
} from "./workflow.ts";

// Tested recipe baseline. Xcode resolves the newest compatible release in this major.
export const CLERK_SWIFT_MINIMUM_VERSION = "1.5.8";
export const SWIFT_QUICKSTART = "https://clerk.com/docs/ios/getting-started/quickstart";

export function setupNextSteps(result: ApplyResult): string[] {
  const initialized = result.handoff.completed.some((item) => item.id === "initialize-clerk");
  return [
    initialized
      ? "Build your app and test your sign-in flow."
      : "Initialize Clerk and connect your sign-in flow using the quickstart, then build and test.",
    `Quickstart: ${SWIFT_QUICKSTART}`,
  ];
}

export function printSetupPreview(preview: SetupPreview): void {
  const { selection } = preview.inspection.input;
  log.info(
    `\nSet up ${selection.targetName} (${preview.inspection.contexts.map((c) => c.selection.configuration).join(", ")})`,
  );
  for (const action of preview.local.actions) {
    if (action.type === "skip") {
      if (!action.skipReason.startsWith("Requested Clerk products are already linked"))
        log.warn(action.skipReason);
    } else log.info(`  ${action.type === "create" ? "Create" : "Update"} ${action.path}`);
  }
  if (preview.remote) {
    log.info(`  Clerk app: ${preview.remote.context.applicationId}`);
    log.info(
      `  Native identity: ${preview.remote.context.appIdPrefix}.${preview.remote.context.bundleIdentifier}`,
    );
    if (preview.remote.actions.includes("register-application"))
      log.info("  Register the native app in Clerk");
    if (preview.remote.actions.includes("enable-native-api")) log.info("  Enable Native API");
  }
  if (preview.appleRequested) log.info("  Configure native Sign in with Apple");
  if (preview.appleWarning) log.warn(preview.appleWarning);
  if (preview.dirtyFiles.length) log.info("  Existing edits will be preserved in backups.");
  if (preview.capabilities?.status === "manual")
    log.warn(preview.capabilities.reason ?? "Some capabilities need manual setup.");
  if (preview.inspection.uncheckedConfigurations.length)
    log.warn(
      `Other configurations need review: ${preview.inspection.uncheckedConfigurations.join(", ")}`,
    );
  if (!preview.starter?.tasks.length)
    log.info("  Swift integration remains: initialize Clerk and connect your sign-in flow.");
}

export function printSetupResult(result: ApplyResult): void {
  if (result.message) log.warn(result.message);
  const completed = result.handoff.completed;
  const summary = [
    completed.some((item) => item.id === "sdk-linkage") && "SDK linked",
    result.packages === "resolved" && "packages downloaded",
    result.capabilities.status === "configured" && "capabilities configured",
    result.remote === "verified" && "native registration verified",
    result.apple === "verified" && "Apple sign-in configured",
    completed.some((item) => item.id === "initialize-clerk") && "starter initialized",
  ].filter(Boolean);
  if (summary.length) log.success(summary.join(" · "));
  for (const item of result.handoff.remaining) log.warn(item.detail);
  if (result.recovery?.needsReview.length)
    log.warn(`Review interrupted edits: ${result.recovery.needsReview.join(", ")}`);
  log.info("\nNext steps:");
  for (const step of setupNextSteps(result)) log.info(`  • ${step}`);
}

export async function runAppleInit(
  options: InitOptions & { root: string; agent: boolean },
  authenticate: () => Promise<string>,
  dependencies: Dependencies = {},
): Promise<void> {
  stopNativeProgress();
  const machine = options.agent || options.json === true;
  const interactive = !machine && !options.yes;
  const signal = interruptSignal();
  const setup: SetupOptions = {
    root: options.root,
    project: options.project,
    target: options.target,
    configuration: options.configuration,
    minimumVersion: CLERK_SWIFT_MINIMUM_VERSION,
    products: options.sdk ?? "ui",
    capabilities: true,
    signInWithApple: options.signInWithApple,
    signInUI: options.prebuiltAuthUI,
    resolvePackages: !options.dryRun,
    inspectOnly: options.dryRun,
    checkAppleConnection: !options.dryRun,
    signal,
    chooseApp:
      interactive && !options.dryRun
        ? async (choices) =>
            select({
              message: "Which app would you like to set up?",
              choices: choices.map((choice) => ({
                name: `${choice.targetName} (${choice.project})`,
                value: choice,
              })),
            })
        : undefined,
    progress: (message) => log.info(message),
  };
  try {
    if (options.dryRun) {
      // No login, profile, or API reads in an inspection-only command.
      const preview = await prepareSetup(
        { ...setup, capabilities: false, signInWithApple: false },
        dependencies,
      );
      if (machine)
        log.data(JSON.stringify({ mode: "read-only", ...describePreview(preview) }, null, 2));
      else {
        printSetupPreview(preview);
        log.info("Run clerk init to choose a Clerk application and configure its capabilities.");
        await outro("Inspection complete; no setup applied");
      }
      return;
    }
    if (machine && !options.yes)
      throwUsageError(
        "Native setup requires --yes in agent/JSON mode. Use --dry-run to inspect without changes.",
      );
    const inspection = await withNativeSpinner("Inspecting Xcode project...", async () =>
      inspectSelectedProject(setup, dependencies.run),
    );
    stopNativeProgress();
    setup.project = inspection.input.selection.project;
    setup.target = inspection.input.selection.targetId;
    const starter = await isUnchangedStarter(inspection);
    let installedProducts: "core" | "ui" | undefined;
    if (!options.sdk && !options.prebuiltAuthUI) {
      for (const products of ["ui", "core"] as const) {
        const action = planAppleSetup({ ...inspection.input, products }).actions[0];
        if (
          action?.type === "skip" &&
          action.skipReason.startsWith("Requested Clerk products are already linked")
        ) {
          installedProducts = products;
          setup.products = products;
          break;
        }
      }
    }
    if (interactive) {
      log.success(
        `Found ${inspection.input.selection.sdk === "macosx" ? "macOS" : "iOS"} app: ${inspection.input.selection.targetName}`,
      );
      if (!options.sdk && !options.prebuiltAuthUI && !installedProducts && !starter)
        setup.products = await select({
          message: "Which Clerk SDK products should this app use?",
          choices: [
            { name: "ClerkKit + ClerkKitUI (prebuilt authentication UI)", value: "ui" as const },
            { name: "ClerkKit (custom authentication UI)", value: "core" as const },
          ],
        });
      if (options.prebuiltAuthUI == null && starter && setup.products === "ui")
        setup.signInUI = await confirm({
          message: "Add Clerk’s prebuilt sign-in screen?",
          default: false,
        });
      if (options.signInWithApple == null)
        setup.signInWithApple = await confirm({
          message: "Enable native Sign in with Apple?",
          default: false,
        });
    }
    const applicationId = await authenticate();
    setup.remote = {
      applicationId,
      bundleIdentifier: options.bundleId,
      appIdPrefix: options.appIdPrefix?.trim(),
    };
    const preview = await prepareSetup(setup, {
      ...dependencies,
      promptIdentity:
        dependencies.promptIdentity ??
        (interactive
          ? async (field, message) =>
              (
                await text({
                  message,
                  validate: (value) =>
                    field === "appIdPrefix"
                      ? /^[A-Z0-9]{10}$/.test(value?.trim() ?? "") ||
                        "Enter the 10-character App ID Prefix from Apple Developer."
                      : /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(value ?? "") ||
                        "Enter the final Bundle ID.",
                })
              ).trim()
          : undefined),
    });
    stopNativeProgress();
    if (!machine) printSetupPreview(preview);
    if (interactive && !(await confirm({ message: "Apply this setup?", default: true })))
      throwUserAbort();
    const result = await applySetup(preview, dependencies, signal);
    stopNativeProgress();
    if (machine) log.data(JSON.stringify(result, null, 2));
    else printSetupResult(result);
    if (result.status === "incomplete")
      throw new CliError(
        "Native setup is incomplete. Review the reported step and rerun clerk init.",
        { code: ERROR_CODE.IOS_SETUP_BLOCKED },
      );
    if (result.status === "manual-steps-required") process.exitCode = 2;
    if (!machine)
      await outro(
        result.status === "manual-steps-required"
          ? "Setup needs attention"
          : result.status === "requires-source-integration"
            ? "Project setup complete; Swift integration remains"
            : "CLI setup complete; app verification remains",
      );
  } catch (error) {
    if (error instanceof IdentityRequired && machine)
      log.data(
        JSON.stringify({
          status: "input-required",
          appIntegrationComplete: false,
          identity: describeIdentity(error.discovery),
        }),
      );
    if (error instanceof SelectionNeeded && machine)
      log.data(
        JSON.stringify({
          status: "selection-required",
          choices: error.choices,
          appIntegrationComplete: false,
        }),
      );
    if (error instanceof ApiError)
      throw new CliError(
        "Could not read Clerk settings. Check your login, application access, and network, then rerun clerk init.",
        { code: ERROR_CODE.IOS_SETUP_BLOCKED },
      );
    throw error;
  }
}
