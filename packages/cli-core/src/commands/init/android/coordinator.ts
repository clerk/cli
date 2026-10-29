import { confirm } from "../../../lib/prompts.ts";
import { select } from "../../../lib/listage.ts";
import { log } from "../../../lib/log.ts";
import { CliError, ERROR_CODE, throwUserAbort } from "../../../lib/errors.ts";
import { setTelemetryStage } from "../../../lib/telemetry.ts";
import { interruptSignal } from "../../../lib/signals.ts";
import { outro } from "../../../lib/spinner.ts";
import { stopNativeProgress, withNativeSpinner } from "../native/progress.ts";
import { SelectionNeeded } from "./discovery.ts";
import { describeIdentity, IdentityRequired } from "./identity.ts";
import { inspectAndroidProject } from "./project.ts";
import { isUnchangedStarter } from "./starter.ts";
import { setupInterrupted, type StarterProjectSummary } from "../native/status.ts";
import { ARTIFACTS, CLERK_ANDROID_MINIMUM_VERSION, sdkInstalled } from "./sdk.ts";
import { ANDROID_QUICKSTART, type AndroidSdk } from "./types.ts";
import {
  applySetup,
  describePreview,
  prepareSetup,
  type ApplyResult,
  type Dependencies,
  type SetupOptions,
  type SetupPreview,
} from "./workflow.ts";

export { CLERK_ANDROID_MINIMUM_VERSION, ANDROID_QUICKSTART };

export function setupNextSteps(result: ApplyResult, starter?: StarterProjectSummary): string[] {
  const initialized = result.handoff.completed.some((item) => item.id === "initialize-clerk");
  if (starter && initialized)
    return [
      `Open ${starter.projectName} in Android Studio, or run \`./gradlew :app:assembleDebug\` there.`,
      "Run the app on an emulator or device and test your sign-in flow.",
      `Quickstart: ${ANDROID_QUICKSTART}`,
    ];
  return [
    initialized
      ? "Sync Gradle, build your app, and connect your sign-in flow using the quickstart."
      : "Initialize Clerk and connect your sign-in flow using the quickstart, then build and test.",
    `Quickstart: ${ANDROID_QUICKSTART}`,
  ];
}

export function printSetupPreview(preview: SetupPreview): void {
  const { selection } = preview.inspection;
  log.info(
    `\nSet up ${selection.applicationId} (${selection.module === "." ? "root module" : selection.module})`,
  );
  for (const action of preview.local.actions) {
    if (action.type === "skip") {
      if (
        action.path !== preview.sdk.path ||
        !sdkInstalled(preview.inspection.dependencies, preview.inspection.sdk)
      )
        log.info(`  ${action.skipReason}`);
    } else
      log.info(
        `  ${action.type === "create" ? "Create" : "Update"} ${action.path}: ${action.description}`,
      );
  }
  if (preview.remote) {
    log.info(`  Clerk app: ${preview.remote.context.applicationId}`);
    log.info(
      `  Native identity: ${preview.remote.context.packageName}${selection.applicationIdSource === "gradle-debug" ? " (debug applicationIdSuffix applied)" : ""}`,
    );
    log.info(
      `  Signing fingerprints: ${preview.remote.context.fingerprints.join(", ") || "none known"}`,
    );
    if (preview.remote.actions.includes("register-application"))
      log.info("  Register the native app in Clerk");
    else if (preview.remote.blocker) log.warn(preview.remote.blocker);
    else log.info("  Native registration already present");
    if (preview.remote.actions.includes("enable-native-api")) log.info("  Enable Native API");
  }
  if (preview.identity?.debug.status !== "found")
    for (const issue of preview.identity?.issues ?? []) log.warn(issue);
  if (preview.kotlinCheck.status !== "pass") log.warn(preview.kotlinCheck.message);
  if (preview.sdkCheck.status === "fail") log.warn(preview.sdkCheck.message);
  if (preview.dirtyFiles.length) log.info("  Existing edits will be preserved in backups.");
  if (!preview.local.initializes)
    log.info("  Kotlin integration remains: initialize Clerk in the Application subclass.");
  else if (!preview.starter?.tasks.length && preview.inspection.sdk === "ui")
    log.info("  Kotlin integration remains: connect your sign-in flow using the quickstart.");
}

export function printSetupResult(result: ApplyResult, starter?: StarterProjectSummary): void {
  if (result.message) log.warn(result.message);
  const completed = result.handoff.completed;
  const summary = [
    completed.some((item) => item.id === "sdk-dependency") && "SDK dependency declared",
    completed.some((item) => item.id === "initialize-clerk") && "Clerk initialized",
    result.remote === "verified" && "native registration verified",
    completed.some((item) => item.id === "optional-sign-in-ui") && "sign-in screen added",
  ].filter(Boolean);
  if (summary.length) log.success(summary.join(" · "));
  for (const item of result.handoff.remaining) log.warn(item.detail);
  if (result.recovery?.needsReview.length)
    log.warn(`Review interrupted edits: ${result.recovery.needsReview.join(", ")}`);
  log.info("\nNext steps:");
  for (const step of setupNextSteps(result, starter)) log.info(`  • ${step}`);
}

/** The Android-specific `clerk init` options, as Commander names them. */
export interface AndroidInitOptions {
  root: string;
  agent: boolean;
  yes?: boolean;
  json?: boolean;
  dryRun?: boolean;
  androidModule?: string;
  androidPackage?: string;
  androidFingerprint?: string[];
  androidSdk?: AndroidSdk;
  /** Add Clerk's prebuilt sign-in screen to an unchanged Compose starter. */
  prebuiltAuthUi?: boolean;
  /** The app `clerk init --starter` just created, which needs no confirmation before setup. */
  starterProject?: StarterProjectSummary;
}

/**
 * Sets up an existing Android app. `applicationId` is the app `clerk init` already linked; a dry
 * run passes none and never authenticates, reads remote state, or runs keytool.
 */
export async function runAndroidInit(
  options: AndroidInitOptions,
  applicationId: string | undefined,
  dependencies: Dependencies = {},
): Promise<void> {
  stopNativeProgress();
  const json = options.json === true;
  // As elsewhere in init, agent mode implies --yes.
  const interactive = !options.agent && !options.yes;
  const signal = interruptSignal();
  const newApp = options.starterProject;
  let reported = false;
  const report = (status: object, indent?: number) => {
    reported = true;
    log.data(JSON.stringify({ ...status, ...(newApp && { starter: newApp }) }, null, indent));
  };
  const setup: SetupOptions = {
    root: options.root,
    module: options.androidModule,
    applicationId: options.androidPackage,
    // A new starter has no screens of its own yet, so it gets the UI artifact by default.
    sdk: options.androidSdk ?? (newApp ? "ui" : "core"),
    minimumVersion: CLERK_ANDROID_MINIMUM_VERSION,
    fingerprints: options.androidFingerprint,
    signInUI: options.prebuiltAuthUi,
    inspectOnly: options.dryRun,
    signal,
    chooseModule:
      interactive && !options.dryRun
        ? async (choices) =>
            select({
              message: "Which Android module would you like to set up?",
              choices: choices.map((choice) => ({ name: choice.module, value: choice })),
            })
        : undefined,
    progress: (message) => log.info(message),
  };
  try {
    setTelemetryStage("android_inspect");
    if (!applicationId) {
      const preview = await prepareSetup(setup, dependencies);
      if (json) report({ mode: "read-only", ...describePreview(preview) }, 2);
      else {
        printSetupPreview(preview);
        log.info(
          "Run clerk init to choose a Clerk application, write its development key, and register the app.",
        );
        await outro("Inspection complete; no setup applied");
      }
      return;
    }
    const inspection = await withNativeSpinner("Inspecting Android project...", async () =>
      inspectAndroidProject(setup),
    );
    stopNativeProgress();
    setup.inspection = inspection;
    const starter = await isUnchangedStarter(inspection);
    // An SDK the project already declares decides the products, as on iOS.
    if (!options.androidSdk)
      for (const sdk of ["ui", "core"] as const)
        if (inspection.dependencies.some((item) => item.product === sdk)) {
          setup.sdk = sdk;
          break;
        }
    // A new starter has no screens of its own yet, so its sign-in screen defaults to on: --yes
    // takes that default as the prompt below offers it. An agent still needs the user to ask for
    // UI changes (see the handoff).
    if (
      newApp &&
      starter &&
      !interactive &&
      !options.agent &&
      options.prebuiltAuthUi == null &&
      setup.sdk === "ui"
    )
      setup.signInUI = true;
    if (interactive) {
      log.success(`Found Android app: ${inspection.selection.applicationId}`);
      if (!options.androidSdk && !inspection.dependencies.length && !starter)
        setup.sdk = await select({
          message: "Which Clerk SDK artifact should this app use?",
          choices: [
            { name: `${ARTIFACTS.core} (custom authentication UI)`, value: "core" as const },
            { name: `${ARTIFACTS.ui} (prebuilt authentication UI)`, value: "ui" as const },
          ],
        });
      if (options.prebuiltAuthUi == null && starter && setup.sdk === "ui")
        setup.signInUI = await confirm({
          message: "Add Clerk’s prebuilt sign-in screen?",
          // A new starter has no screens of its own yet.
          default: newApp != null,
        });
    }
    if (setup.sdk !== inspection.sdk) setup.inspection = { ...inspection, sdk: setup.sdk };
    setup.remote = { applicationId };
    setTelemetryStage("android_plan");
    const preview = await withNativeSpinner("Planning setup...", async () =>
      prepareSetup(setup, dependencies),
    );
    stopNativeProgress();
    if (!json) printSetupPreview(preview);
    if (interactive && !newApp && !(await confirm({ message: "Apply this setup?", default: true })))
      throwUserAbort();
    setTelemetryStage("android_apply");
    const result = await applySetup(preview, dependencies, signal);
    stopNativeProgress();
    if (json) report(result, 2);
    else printSetupResult(result, newApp);
    if (result.status === "incomplete")
      throw new CliError(
        result.message ??
          "Native setup is incomplete. Review the reported step and rerun clerk init.",
        { code: ERROR_CODE.ANDROID_SETUP_BLOCKED },
      );
    setTelemetryStage("done");
    if (!json)
      await outro(
        result.status === "manual-steps-required"
          ? "Setup needs attention"
          : result.status === "requires-source-integration"
            ? "Project setup complete; Kotlin integration remains"
            : "CLI setup complete; app verification remains",
      );
  } catch (error) {
    if (json && !reported && error instanceof IdentityRequired)
      report({
        status: "input-required",
        appIntegrationComplete: false,
        identity: {
          ...describeIdentity(error.identity),
          flag: "--android-fingerprint",
          question: `Which SHA-256 signing certificate fingerprint should Clerk register for ${error.identity.applicationId}?`,
        },
      });
    else if (json && !reported && error instanceof SelectionNeeded)
      report({
        status: "selection-required",
        choices: error.choices,
        appIntegrationComplete: false,
      });
    else if (json && newApp && !reported) report(setupInterrupted(newApp, error), 2);
    throw error;
  }
}
