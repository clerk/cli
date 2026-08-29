import { ApiError, CliError, ERROR_CODE, throwUsageError } from "../../../lib/errors.js";
import { resolveProfile } from "../../../lib/config.js";
import { decodePublishableKey, fetchUserSettings } from "../../../lib/fapi.ts";
import { log } from "../../../lib/log.js";
import { interruptedExitCode } from "../../../lib/signals.ts";
import { outro, withSpinner } from "../../../lib/spinner.js";
import { setTelemetryStage, type TelemetryStage } from "../../../lib/telemetry.ts";
import { applyIOSLocalSetup, applyIOSPlannedLocalSetup } from "./apply.ts";
import {
  applyIOSNativeAppleConnection,
  prepareIOSNativeAppleConnection,
  type IOSNativeApplePlan,
} from "./native-apple.ts";
import {
  applyIOSNativeRemoteSetup,
  assertIOSAppIdPrefixBeforeApplicationCreation,
  prepareIOSNativeRemoteSetup,
} from "./native-remote.ts";
import { auditIOSPrebuiltAuthEnvironment } from "./prebuilt-auth-environment.ts";
import { recoverIOSFileTransactions } from "./file-transaction.ts";
import { resolveIOSDevelopmentPublicKey } from "./development-key.ts";
import { inspectIOSProject } from "./inspect.ts";
import { type IOSLocalSetupResult } from "./apply.ts";
import { createIOSDryRunOutput, formatIOSSetupPlan } from "./output.ts";
import { buildIOSLocalSetupProposal, createIOSLocalSetupContext } from "./local-plan.ts";

type LinkedProfile = Awaited<ReturnType<typeof resolveProfile>>;

export type AppleNativeDryRunOptions = {
  root: string;
  target?: string;
  signInWithApple?: boolean;
  prebuiltAuthUI?: boolean;
  machineOutput: boolean;
};

export type PrepareAppleNativeSetupOptions = {
  root: string;
  target?: string;
  yes: boolean;
  agent: boolean;
  allowDirty: boolean;
  signInWithApple?: boolean;
  prebuiltAuthUI?: boolean;
  requestedApplicationId?: string;
  validatedAgentAuthLabel?: string | null;
  validateAgentAuthentication: () => Promise<string | null>;
};

export type CompleteAppleNativeSetupOptions = {
  authenticationCompleted: boolean;
  applicationId?: string;
  applicationLinkChange?: "created-and-linked" | "link-updated";
  appIdPrefix?: string;
};

export type AppleNativeSetupResult = {
  authenticatedKeysHandled: boolean;
  nativeRemoteReady: boolean;
  nativeAppleReady: boolean;
};

export type AppleNativeSetupCoordinator = {
  linkedProfile: LinkedProfile;
  validatedAgentAuthLabel?: string;
  preauthenticatedLabel?: string;
  targetName: string;
  requiresLinkedApp: boolean;
  requiresExplicitApplication: boolean;
  shouldCreateApplication(requestedApplicationId?: string): boolean;
  assertApplicationCreationReady(options: {
    requestedApplicationId?: string;
    appIdPrefix?: string;
  }): void;
  complete(options: CompleteAppleNativeSetupOptions): Promise<AppleNativeSetupResult>;
};

/**
 * Owns the complete read-only native planning flow. Generic init only decides
 * that the detected framework is Apple-native and delegates the native plan.
 */
export async function runAppleNativeDryRun(options: AppleNativeDryRunOptions): Promise<void> {
  setTelemetryStage("ios_inspect");
  const inspect = async () =>
    inspectIOSProject(options.root, {
      target: options.target,
      exhaustiveContainerDiscovery: true,
    });
  const inspection = options.machineOutput
    ? await inspect()
    : await withSpinner("Inspecting Xcode project...", inspect);
  const proposal = await buildIOSLocalSetupProposal(createIOSLocalSetupContext(inspection), {
    root: options.root,
    allowDirty: false,
    prebuiltAuthUI: options.prebuiltAuthUI,
    signInWithApple: options.signInWithApple,
  });
  const plan = proposal.setupPlan;
  const associatedDomainPlan = proposal.plannedAssociatedDomain;
  if (options.machineOutput) {
    log.data(
      JSON.stringify(
        createIOSDryRunOutput(inspection, plan, {
          associatedDomainPlan,
          nativeReadiness: proposal.nativeReadiness,
        }),
        null,
        2,
      ),
    );
  } else {
    log.info(
      formatIOSSetupPlan(inspection, plan, {
        associatedDomainPlan,
        nativeReadiness: proposal.nativeReadiness,
      }),
    );
    await outro(plan.status === "ready" ? "Setup looks ready" : "Setup incomplete");
  }
  setTelemetryStage("done");
}

/**
 * Prepares and authorizes native local work without committing it. Application
 * authentication/linking remains generic and happens between prepare and
 * complete.
 */
export async function prepareAppleNativeSetup(
  options: PrepareAppleNativeSetupOptions,
): Promise<AppleNativeSetupCoordinator> {
  await recoverIOSFileTransactions(options.root);

  const linkedProfile = await resolveProfile(options.root);
  let validatedAgentAuthLabel = options.validatedAgentAuthLabel;
  if (options.agent && validatedAgentAuthLabel === undefined) {
    validatedAgentAuthLabel = await options.validateAgentAuthentication();
  }
  if (options.agent && validatedAgentAuthLabel === null) {
    throwUsageError(
      "Native Apple setup in agent mode requires valid Clerk authentication before any Xcode files can be changed. Ask the user to run `clerk auth login` or provide a valid Platform API key, then rerun `clerk init`.",
    );
  }

  setTelemetryStage("ios_inspect");
  const localSetup = await applyIOSLocalSetup({
    root: options.root,
    target: options.target,
    yes: options.yes,
    agent: options.agent,
    allowDirty: options.allowDirty,
    signInWithApple: options.signInWithApple,
    prebuiltAuthUI: options.prebuiltAuthUI,
  });
  if (options.agent && localSetup.requiresExplicitApplication && !options.requestedApplicationId) {
    throwUsageError(
      "This native Apple target already contains a publishable-key configuration that requires explicit Clerk application selection. Ask the developer which existing application it belongs to, then rerun with --app <app_id>. No local files were changed.",
    );
  }

  const authLabel = validatedAgentAuthLabel ?? undefined;
  return {
    linkedProfile,
    validatedAgentAuthLabel: authLabel,
    preauthenticatedLabel: options.agent ? authLabel : undefined,
    targetName: localSetup.targetName,
    requiresLinkedApp: localSetup.requiresLinkedApp,
    requiresExplicitApplication: localSetup.requiresExplicitApplication,
    shouldCreateApplication(requestedApplicationId) {
      return !linkedProfile && !requestedApplicationId;
    },
    assertApplicationCreationReady({ requestedApplicationId, appIdPrefix }) {
      if (
        options.agent &&
        localSetup.requiresLinkedApp &&
        !linkedProfile &&
        !requestedApplicationId
      ) {
        assertIOSAppIdPrefixBeforeApplicationCreation({
          target: localSetup.nativeReadiness.target,
          appIdPrefix,
          ...(localSetup.unverifiedAppIdPrefixSuggestion
            ? {
                unverifiedAppIdPrefixSuggestion: localSetup.unverifiedAppIdPrefixSuggestion,
              }
            : {}),
        });
      }
    },
    complete: async (completeOptions) =>
      completeAppleNativeSetup(options, localSetup, completeOptions),
  };
}

async function completeAppleNativeSetup(
  preparation: PrepareAppleNativeSetupOptions,
  localSetup: IOSLocalSetupResult,
  options: CompleteAppleNativeSetupOptions,
): Promise<AppleNativeSetupResult> {
  if (!localSetup.requiresLinkedApp) {
    setTelemetryStage("ios_local_setup");
    await applyIOSPlannedLocalSetup(localSetup);
    return {
      authenticatedKeysHandled: false,
      nativeRemoteReady: false,
      nativeAppleReady: false,
    };
  }
  if (!options.authenticationCompleted) {
    throw new CliError(
      "The approved iOS configuration requires a linked Clerk application, but authentication did not complete. No local setup changes were written.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }
  if (!options.applicationId) {
    throw new CliError(
      "The Clerk application link could not be verified. No local setup changes were written.",
      { code: ERROR_CODE.NOT_LINKED },
    );
  }

  setTelemetryStage("keys");
  const keys = await withSpinner("Fetching the development publishable key...", async () =>
    resolveIOSDevelopmentPublicKey(options.applicationId!),
  );
  if (keys.applicationId !== options.applicationId) {
    throw new CliError(
      "The linked Clerk application changed while its iOS publishable key was being resolved. No local setup changes were written; rerun clerk init.",
      { code: ERROR_CODE.IOS_SETUP_STALE },
    );
  }

  let setupForCommit = localSetup;
  let inspectedAuthViewAppleRequirement: "required" | "not-required" | undefined;
  if (localSetup.prebuiltAuthActive) {
    const authEnvironment = await inspectAuthViewEnvironment(
      keys.publishableKey,
      "Inspecting AuthView authentication methods...",
      "inspected",
      "No local setup changes were written",
    );
    if (authEnvironment.apple === "blocked") {
      throw new CliError(`${authEnvironment.message} No local setup changes were written.`, {
        code: ERROR_CODE.IOS_SETUP_BLOCKED,
      });
    }
    inspectedAuthViewAppleRequirement = authEnvironment.apple;
    if (authEnvironment.apple === "required") {
      const conditionalPlan = localSetup.prebuiltAuthAppleEntitlementPlan;
      if (!conditionalPlan || conditionalPlan.status === "blocked") {
        const reasons = conditionalPlan?.blockers
          .map((blocker) => `  • ${blocker.message}`)
          .join("\n");
        throw new CliError(
          `AuthView exposes Sign in with Apple for the linked development instance, but the required selected-target entitlement could not be prepared safely. No local setup changes were written${
            reasons ? `:\n${reasons}` : "."
          }`,
          { code: ERROR_CODE.IOS_SETUP_BLOCKED },
        );
      }
    }
  }

  setTelemetryStage("ios_native_plan");
  const nativeRemotePlan = await prepareIOSNativeRemoteSetup({
    applicationId: keys.applicationId,
    instanceId: keys.instanceId,
    root: localSetup.nativeReadiness.root,
    target: localSetup.nativeReadiness.target,
    appIdPrefix: options.appIdPrefix,
    ...(localSetup.unverifiedAppIdPrefixSuggestion
      ? { unverifiedAppIdPrefixSuggestion: localSetup.unverifiedAppIdPrefixSuggestion }
      : {}),
    ...(options.applicationLinkChange
      ? { applicationLinkChange: options.applicationLinkChange }
      : {}),
    agent: preparation.agent,
    yes: preparation.yes,
  });
  let nativeApplePlan: IOSNativeApplePlan | undefined;
  if (localSetup.nativeAppleRequested) {
    if (!localSetup.appleEntitlementPlan) {
      throw new CliError(
        "Native Sign in with Apple was requested without a validated local entitlement plan. No local or Apple connection changes were written; rerun clerk init.",
        { code: ERROR_CODE.IOS_SETUP_PLAN_INVALID },
      );
    }
    const target = localSetup.nativeReadiness.target;
    if (target.status !== "selected" || target.bundleIdentifier.status !== "resolved") {
      throw new CliError(
        "The selected iOS Bundle ID could not be revalidated for native Sign in with Apple. No local or Apple connection changes were written.",
        { code: ERROR_CODE.IOS_TARGET_UNRESOLVED },
      );
    }
    if (!nativeRemotePlan.bundleIdentifier) {
      throw new CliError(
        "The selected iOS Bundle ID could not be matched to its Clerk Native Application registration. No local or Apple connection changes were written.",
        { code: ERROR_CODE.IOS_SETUP_PLAN_INVALID },
      );
    }
    setTelemetryStage("ios_apple_plan");
    const preparedApple = await prepareIOSNativeAppleConnection({
      applicationId: keys.applicationId,
      instanceId: keys.instanceId,
      platform: target.platform,
      bundleIdentifier: nativeRemotePlan.bundleIdentifier,
      nativeApplicationReady:
        nativeRemotePlan.status !== "blocked" && nativeRemotePlan.registration !== "blocked",
      requested: true,
      agent: preparation.agent,
      yes: preparation.yes,
    });
    if (preparedApple.status === "skipped") {
      throw new CliError(
        "Native Sign in with Apple was selected locally but its Clerk connection plan was skipped. No local or Apple connection changes were written; rerun clerk init.",
        { code: ERROR_CODE.IOS_SETUP_PLAN_INVALID },
      );
    }
    nativeApplePlan = preparedApple;
  }

  const commitProfile = await resolveProfile(preparation.root);
  if (commitProfile?.profile.appId !== options.applicationId) {
    throw new CliError(
      "The local Clerk application link changed before the approved iOS setup could be committed. No local or remote setup changes were written; rerun clerk init.",
      { code: ERROR_CODE.IOS_SETUP_STALE },
    );
  }

  if (localSetup.prebuiltAuthActive) {
    const authEnvironment = await inspectAuthViewEnvironment(
      keys.publishableKey,
      "Revalidating AuthView authentication methods...",
      "revalidated",
      "No local or remote setup changes were written",
    );
    if (authEnvironment.apple === "blocked") {
      throw new CliError(
        `${authEnvironment.message} No local or remote setup changes were written.`,
        { code: ERROR_CODE.IOS_SETUP_BLOCKED },
      );
    }
    if (authEnvironment.apple !== inspectedAuthViewAppleRequirement) {
      throw new CliError(
        "The linked Clerk application's AuthView methods changed while the approved iOS setup was being prepared. No local or remote setup changes were written; rerun clerk init.",
        { code: ERROR_CODE.IOS_SETUP_STALE },
      );
    }
    if (authEnvironment.apple === "required") {
      const conditionalPlan = localSetup.prebuiltAuthAppleEntitlementPlan;
      if (!conditionalPlan || conditionalPlan.status === "blocked") {
        throw new CliError(
          "AuthView exposes Sign in with Apple for the linked development instance, but the required selected-target entitlement could not be revalidated safely. No local or remote setup changes were written; rerun clerk init.",
          { code: ERROR_CODE.IOS_SETUP_STALE },
        );
      }
      setupForCommit = {
        ...localSetup,
        appleEntitlementPlan: localSetup.appleEntitlementPlan ?? conditionalPlan,
        prebuiltAuthAppleEntitlementPlan: undefined,
      };
    } else {
      setupForCommit = {
        ...localSetup,
        prebuiltAuthAppleEntitlementPlan: undefined,
      };
    }
  }

  setTelemetryStage("ios_local_setup");
  await applyIOSPlannedLocalSetup(
    setupForCommit,
    setupForCommit.requiresDevelopmentKey ? keys.publishableKey : undefined,
  );
  await assertApplicationLinkStillMatches({
    root: preparation.root,
    applicationId: nativeRemotePlan.applicationId,
    phase: "native-application",
  });
  await applyRemoteStep(
    "ios_native_setup",
    async () => applyIOSNativeRemoteSetup(nativeRemotePlan),
    "Could not reconcile Clerk Native Application settings; underlying error details were omitted.",
    "The local iOS setup completed, but Clerk Native Application settings could not be completed remotely. Local changes remain intact; rerun clerk init to safely reconcile the additive remote steps.",
  );
  log.success("Clerk Native API and iOS application registration verified");

  if (nativeApplePlan) {
    await assertApplicationLinkStillMatches({
      root: preparation.root,
      applicationId: nativeApplePlan.applicationId,
      phase: "native-apple",
    });
    await applyRemoteStep(
      "ios_apple_setup",
      async () => applyIOSNativeAppleConnection(nativeApplePlan),
      "Could not reconcile the native Apple connection; underlying error details were omitted.",
      "The local iOS setup and Clerk Native Application registration completed, but the native Apple connection could not be completed. Those completed changes remain intact; rerun clerk init to reconcile Sign in with Apple safely.",
    );
  }

  return {
    authenticatedKeysHandled: true,
    nativeRemoteReady: true,
    nativeAppleReady: nativeApplePlan != null,
  };
}

async function inspectAuthViewEnvironment(
  publishableKey: string,
  spinner: string,
  verb: "inspected" | "revalidated",
  unchangedMessage: string,
): Promise<ReturnType<typeof auditIOSPrebuiltAuthEnvironment>> {
  return withSpinner(spinner, async () => {
    try {
      const { fapiHost } = decodePublishableKey(publishableKey);
      const settings = await fetchUserSettings(fapiHost, {});
      return auditIOSPrebuiltAuthEnvironment(settings);
    } catch (error) {
      if (interruptedExitCode() !== null) throw error;
      if (error instanceof ApiError || error instanceof CliError) throw error;
      log.debug(
        `Could not ${verb === "inspected" ? "inspect" : "revalidate"} AuthView authentication methods; underlying error details were omitted.`,
      );
      throw new CliError(
        `The linked Clerk application's AuthView methods could not be ${verb} safely. ${unchangedMessage}; rerun clerk init.`,
        { code: ERROR_CODE.IOS_REMOTE_VERIFY_FAILED },
      );
    }
  });
}

async function applyRemoteStep(
  stage: TelemetryStage,
  apply: () => Promise<void>,
  debugMessage: string,
  failureMessage: string,
): Promise<void> {
  try {
    setTelemetryStage(stage);
    await apply();
  } catch (error) {
    if (interruptedExitCode() !== null) throw error;
    if (error instanceof ApiError || error instanceof CliError) throw error;
    log.debug(debugMessage);
    throw new CliError(failureMessage, { code: ERROR_CODE.IOS_REMOTE_APPLY_FAILED });
  }
}

async function assertApplicationLinkStillMatches(options: {
  root: string;
  applicationId: string;
  phase: "native-application" | "native-apple";
}): Promise<void> {
  const linked = await resolveProfile(options.root);
  if (linked?.profile.appId === options.applicationId) return;

  const message =
    options.phase === "native-application"
      ? "The local Clerk application link changed after the approved iOS setup was committed. Local changes remain intact, but no Clerk Native Application changes were made; rerun clerk init."
      : "The local Clerk application link changed after Clerk Native Application setup completed. The completed local and Clerk Native Application changes remain intact, but no native Apple connection changes were made; rerun clerk init.";
  throw new CliError(message, { code: ERROR_CODE.IOS_SETUP_STALE });
}
