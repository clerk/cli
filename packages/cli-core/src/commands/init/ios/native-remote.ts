import { randomUUID } from "node:crypto";
import { dim, yellow } from "../../../lib/color.ts";
import {
  ApiError,
  CliError,
  ERROR_CODE,
  type ErrorCode,
  errorMessage,
  throwUsageError,
  throwUserAbort,
} from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { select } from "../../../lib/listage.ts";
import {
  createIOSApplication,
  enableNativeApi,
  getNativeSettings,
  listIOSApplications,
  type IOSApplication,
  type NativeSettings,
} from "../../../lib/plapi.ts";
import { confirm, text } from "../../../lib/prompts.ts";
import { withSpinner } from "../../../lib/spinner.ts";
import { hasIncompleteIOSContainerDiscovery, inspectIOSProject } from "./inspect.ts";
import type {
  IOSNativeReadinessTarget,
  IOSUnverifiedAppIdPrefixSuggestion,
} from "./native-readiness.ts";
import { buildIOSNativeReadinessAudit } from "./native-readiness.ts";
import {
  cliStateIOSNativeRegistrationRetryStore,
  type IOSNativeRegistrationRetryIdentity,
  type IOSNativeRegistrationRetryStore,
} from "./native-registration-retry.ts";

const APP_ID_PREFIX_MAX_LENGTH = 255;

function iosRemoteError(
  message: string,
  code: ErrorCode = ERROR_CODE.IOS_REMOTE_APPLY_FAILED,
): CliError {
  return new CliError(message, { code });
}

function rethrowKnownRemoteError(error: unknown): void {
  if (error instanceof CliError || error instanceof ApiError) throw error;
}

export type IOSNativeRemoteBlockerCode =
  | "target-not-selected"
  | "bundle-identifier-unavailable"
  | "app-id-prefix-required"
  | "app-id-prefix-conflict"
  | "duplicate-bundle-registration";

export interface IOSNativeRemoteBlocker {
  code: IOSNativeRemoteBlockerCode;
  message: string;
}

type IOSSelectedNativeReadinessTarget = Extract<IOSNativeReadinessTarget, { status: "selected" }>;

export interface IOSNativeRemoteTargetSnapshot {
  root: string;
  projectPath: string;
  targetId: string;
  bundleIdentifier: IOSSelectedNativeReadinessTarget["bundleIdentifier"];
  appIdPrefix: IOSSelectedNativeReadinessTarget["appIdPrefix"];
}

export type IOSNativeRemotePlan = {
  schemaVersion: 1;
  kind: "clerk-ios-native-remote-setup";
  status: "ready" | "satisfied" | "blocked";
  applicationId: string;
  instanceId: string;
  localTarget?: IOSNativeRemoteTargetSnapshot;
  bundleIdentifier?: string;
  appIdPrefix?: string;
  nativeApi: "required" | "satisfied";
  registration: "required" | "satisfied" | "blocked";
  actions: string[];
  blockers: IOSNativeRemoteBlocker[];
};

export interface IOSNativeRemoteAPI {
  getNativeSettings(applicationId: string, instanceId: string): Promise<NativeSettings>;
  enableNativeApi(
    applicationId: string,
    instanceId: string,
    options: { idempotencyKey: string },
  ): Promise<NativeSettings>;
  listIOSApplications(applicationId: string, instanceId: string): Promise<IOSApplication[]>;
  createIOSApplication(
    applicationId: string,
    instanceId: string,
    params: { appIdPrefix: string; bundleId: string },
    options: { idempotencyKey: string },
  ): Promise<IOSApplication>;
}

const defaultAPI: IOSNativeRemoteAPI = {
  getNativeSettings,
  enableNativeApi,
  listIOSApplications,
  createIOSApplication,
};

export interface PrepareIOSNativeRemoteSetupOptions {
  applicationId: string;
  instanceId: string;
  root: string;
  target: IOSNativeReadinessTarget;
  appIdPrefix?: string;
  unverifiedAppIdPrefixSuggestion?: IOSUnverifiedAppIdPrefixSuggestion;
  /** A completed application/link change that must be reported if planning stops here. */
  applicationLinkChange?: "created-and-linked" | "link-updated";
  agent: boolean;
  yes: boolean;
}

export type IOSNativeRemoteAppIdPrefixSuggestion =
  | IOSUnverifiedAppIdPrefixSuggestion
  | { source: "partial-literal-entitlements"; value: string };

export type IOSNativeRemoteTargetReader = (
  snapshot: IOSNativeRemoteTargetSnapshot,
) => Promise<IOSNativeReadinessTarget>;

export interface IOSNativeRemotePrompts {
  appIdPrefix(
    bundleIdentifier: string,
    suggested?: IOSNativeRemoteAppIdPrefixSuggestion,
  ): Promise<string>;
  confirmChanges(): Promise<boolean>;
}

const defaultPrompts: IOSNativeRemotePrompts = {
  appIdPrefix: async (bundleIdentifier, suggested) => {
    if (suggested?.source === "xcode-development-team") {
      const choice = await select({
        message: `Apple App ID Prefix for ${bundleIdentifier}`,
        choices: [
          {
            name: `Use ${suggested.value}`,
            value: "use-suggested" as const,
            description:
              "Suggested from Xcode DEVELOPMENT_TEAM; usually matches, but legacy Apple accounts can differ.",
          },
          {
            name: "Enter a different App ID Prefix",
            value: "enter-different" as const,
          },
        ],
        default: "use-suggested" as const,
      });
      if (choice === "use-suggested") return suggested.value;
    }

    return text({
      message: `Apple App ID Prefix for ${bundleIdentifier}`,
      default: suggested?.source === "partial-literal-entitlements" ? suggested.value : undefined,
      placeholder: suggested?.value ?? "ABCDE12345",
      validate: (value) =>
        validateAppIdPrefix(value) ??
        `Enter an App ID Prefix between 1 and ${APP_ID_PREFIX_MAX_LENGTH} characters. Verify it in Apple Developer; it can differ from your Team ID.`,
    });
  },
  confirmChanges: async () =>
    confirm({ message: "Apply these remote Clerk Native Application changes?", default: false }),
};

function blocker(code: IOSNativeRemoteBlockerCode, message: string): IOSNativeRemoteBlocker {
  return { code, message };
}

export function validateAppIdPrefix(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized && normalized.length <= APP_ID_PREFIX_MAX_LENGTH ? normalized : undefined;
}

function copyTargetSnapshot(
  root: string | undefined,
  target: IOSNativeReadinessTarget,
): IOSNativeRemoteTargetSnapshot | undefined {
  if (!root || target.status !== "selected") return undefined;
  return {
    root,
    projectPath: target.projectPath,
    targetId: target.targetId,
    bundleIdentifier:
      target.bundleIdentifier.status === "conflicting"
        ? { ...target.bundleIdentifier, candidates: [...target.bundleIdentifier.candidates] }
        : { ...target.bundleIdentifier },
    appIdPrefix:
      target.appIdPrefix.status === "resolved"
        ? { ...target.appIdPrefix }
        : {
            ...target.appIdPrefix,
            ...(target.appIdPrefix.candidates
              ? { candidates: [...target.appIdPrefix.candidates] }
              : {}),
          },
  };
}

const defaultTargetReader: IOSNativeRemoteTargetReader = async (snapshot) => {
  const inspection = await inspectIOSProject(snapshot.root, {
    target: snapshot.targetId,
    exhaustiveContainerDiscovery: true,
  });
  if (hasIncompleteIOSContainerDiscovery(inspection)) {
    return { status: "blocked", reason: "target-not-selected" };
  }
  return buildIOSNativeReadinessAudit(inspection).target;
};

function localIdentity(target: IOSNativeReadinessTarget): {
  bundleIdentifier?: string;
  appIdPrefix?: string;
  appIdPrefixCandidates: string[];
  blockers: IOSNativeRemoteBlocker[];
} {
  if (target.status !== "selected") {
    return {
      appIdPrefixCandidates: [],
      blockers: [
        blocker(
          "target-not-selected",
          "Select exactly one iOS application target before registering it with Clerk.",
        ),
      ],
    };
  }

  if (target.bundleIdentifier.status !== "resolved") {
    return {
      appIdPrefixCandidates: [],
      blockers: [
        blocker(
          "bundle-identifier-unavailable",
          "Resolve one Bundle ID across every selected-target build configuration before registering the iOS app with Clerk.",
        ),
      ],
    };
  }

  const appIdPrefixCandidates =
    target.appIdPrefix.status === "resolved"
      ? [target.appIdPrefix.value]
      : target.appIdPrefix.status === "conflicting"
        ? target.appIdPrefix.candidates
        : (target.appIdPrefix.candidates ?? []);
  const blockers: IOSNativeRemoteBlocker[] = [];
  if (target.appIdPrefix.status === "conflicting") {
    blockers.push(
      blocker(
        "app-id-prefix-conflict",
        "The selected target contains conflicting literal App ID Prefix evidence across its build configurations.",
      ),
    );
  }

  return {
    bundleIdentifier: target.bundleIdentifier.value,
    appIdPrefix: target.appIdPrefix.status === "resolved" ? target.appIdPrefix.value : undefined,
    appIdPrefixCandidates,
    blockers,
  };
}

export function buildIOSNativeRemotePlan(options: {
  applicationId: string;
  instanceId: string;
  root?: string;
  target: IOSNativeReadinessTarget;
  requestedAppIdPrefix?: string;
  nativeSettings: NativeSettings;
  registrations: IOSApplication[];
}): IOSNativeRemotePlan {
  const identity = localIdentity(options.target);
  const blockers = [...identity.blockers];
  const bundleIdentifier = identity.bundleIdentifier;
  const explicitPrefix = validateAppIdPrefix(options.requestedAppIdPrefix);
  if (options.requestedAppIdPrefix != null && !explicitPrefix) {
    blockers.push(
      blocker(
        "app-id-prefix-required",
        `The Apple App ID Prefix must contain between 1 and ${APP_ID_PREFIX_MAX_LENGTH} characters after trimming.`,
      ),
    );
  }
  if (
    explicitPrefix &&
    identity.appIdPrefixCandidates.some((candidate) => candidate !== explicitPrefix)
  ) {
    blockers.push(
      blocker(
        "app-id-prefix-conflict",
        `The supplied App ID Prefix does not match the literal prefix proven for ${bundleIdentifier ?? "the selected target"}.`,
      ),
    );
  }

  const matchingBundle = bundleIdentifier
    ? options.registrations.filter((registration) => registration.bundle_id === bundleIdentifier)
    : [];
  const registeredPrefixes = [...new Set(matchingBundle.map((item) => item.app_id_prefix))].sort();
  const selectedPrefix = explicitPrefix ?? identity.appIdPrefix;
  let appIdPrefix = selectedPrefix;
  let registration: IOSNativeRemotePlan["registration"] = "blocked";

  if (bundleIdentifier) {
    if (selectedPrefix) {
      const conflicts = registeredPrefixes.filter((prefix) => prefix !== selectedPrefix);
      if (conflicts.length > 0) {
        blockers.push(
          blocker(
            "app-id-prefix-conflict",
            `${bundleIdentifier} is already registered with a different App ID Prefix. Review the Native Applications page; clerk init will not replace it.`,
          ),
        );
      } else {
        registration = registeredPrefixes.includes(selectedPrefix) ? "satisfied" : "required";
      }
    } else if (registeredPrefixes.length === 1) {
      appIdPrefix = registeredPrefixes[0];
      if (identity.appIdPrefixCandidates.some((candidate) => candidate !== appIdPrefix)) {
        blockers.push(
          blocker(
            "app-id-prefix-conflict",
            `The existing Clerk registration for ${bundleIdentifier} conflicts with literal App ID Prefix evidence in the selected target.`,
          ),
        );
      } else {
        registration = "satisfied";
      }
    } else if (registeredPrefixes.length > 1) {
      blockers.push(
        blocker(
          "duplicate-bundle-registration",
          `${bundleIdentifier} has more than one App ID Prefix registration. Review the Native Applications page before continuing.`,
        ),
      );
    } else {
      blockers.push(
        blocker(
          "app-id-prefix-required",
          `An Apple App ID Prefix is required to register ${bundleIdentifier}.`,
        ),
      );
    }
  }

  const nativeApi = options.nativeSettings.api_enabled ? "satisfied" : "required";
  const actions: string[] = [];
  if (registration === "required" && appIdPrefix && bundleIdentifier) {
    actions.push(
      `Register iOS Bundle ID ${bundleIdentifier} with Apple App ID Prefix ${appIdPrefix}.`,
    );
  }
  if (nativeApi === "required") {
    actions.push("Enable the Native API for the linked development instance.");
  }

  const status =
    blockers.length > 0
      ? "blocked"
      : nativeApi === "satisfied" && registration === "satisfied"
        ? "satisfied"
        : "ready";
  return {
    schemaVersion: 1,
    kind: "clerk-ios-native-remote-setup",
    status,
    applicationId: options.applicationId,
    instanceId: options.instanceId,
    localTarget: copyTargetSnapshot(options.root, options.target),
    bundleIdentifier,
    appIdPrefix,
    nativeApi,
    registration,
    actions,
    blockers,
  };
}

async function readRemoteState(
  applicationId: string,
  instanceId: string,
  api: IOSNativeRemoteAPI,
): Promise<{ nativeSettings: NativeSettings; registrations: IOSApplication[] }> {
  const [nativeSettings, registrations] = await Promise.all([
    api.getNativeSettings(applicationId, instanceId),
    api.listIOSApplications(applicationId, instanceId),
  ]);
  return { nativeSettings, registrations };
}

function formatBlockers(plan: IOSNativeRemotePlan): string {
  return plan.blockers.map((item) => `  • ${item.message}`).join("\n");
}

function nativeSetupOutcome(
  applicationLinkChange?: PrepareIOSNativeRemoteSetupOptions["applicationLinkChange"],
): string {
  return applicationLinkChange === "created-and-linked"
    ? "A new Clerk application was created and linked, but no Xcode or Clerk Native Application settings changes were written."
    : applicationLinkChange === "link-updated"
      ? "The project's Clerk application link was updated, but no Xcode or Clerk Native Application settings changes were written."
      : "No local or remote setup changes were written.";
}

function agentAppIdPrefixRequiredMessage(
  bundleIdentifier: string,
  suggestion?: IOSNativeRemoteAppIdPrefixSuggestion,
  applicationLinkChange?: PrepareIOSNativeRemoteSetupOptions["applicationLinkChange"],
): string {
  const retry =
    'After the user confirms the value, rerun the same command with --app-id-prefix "<confirmed_prefix>".';
  const outcome = nativeSetupOutcome(applicationLinkChange);

  if (!suggestion) {
    return `Registering ${bundleIdentifier} in agent mode requires --app-id-prefix <prefix>. Ask the user to copy the value labeled App ID Prefix in Apple Developer. ${retry} ${outcome}`;
  }

  const source =
    suggestion.source === "xcode-development-team"
      ? "the selected target's Xcode DEVELOPMENT_TEAM setting. DEVELOPMENT_TEAM often matches the Apple App ID Prefix, but older Apple Developer accounts can differ"
      : "literal App ID Prefix evidence found in only some of the selected target's entitlement configurations, so it could not be verified across the whole target";

  return `Registering ${bundleIdentifier} in agent mode requires a confirmed App ID Prefix through --app-id-prefix <prefix>. The CLI found ${suggestion.value} from ${source}. Treat it only as an unverified suggestion: do not use it automatically. Ask the user whether to use ${suggestion.value} or enter a different App ID Prefix. ${retry} ${outcome}`;
}

function appIdPrefixSuggestion(
  target: IOSNativeReadinessTarget,
  unverifiedSuggestion?: IOSUnverifiedAppIdPrefixSuggestion,
): IOSNativeRemoteAppIdPrefixSuggestion | undefined {
  const literalSuggestion =
    target.status === "selected" && target.appIdPrefix.status === "missing"
      ? target.appIdPrefix.candidates?.length === 1
        ? {
            source: "partial-literal-entitlements" as const,
            value: target.appIdPrefix.candidates[0]!,
          }
        : undefined
      : undefined;
  return literalSuggestion ?? unverifiedSuggestion;
}

/**
 * A newly created Clerk application cannot already contain the selected iOS
 * registration. Stop before application creation when agent mode still needs
 * the user to confirm an App ID Prefix.
 */
export function assertIOSAppIdPrefixBeforeApplicationCreation(options: {
  target: IOSNativeReadinessTarget;
  appIdPrefix?: string;
  unverifiedAppIdPrefixSuggestion?: IOSUnverifiedAppIdPrefixSuggestion;
}): void {
  const plan = buildIOSNativeRemotePlan({
    applicationId: "preflight",
    instanceId: "preflight",
    target: options.target,
    requestedAppIdPrefix: options.appIdPrefix,
    nativeSettings: { object: "native_settings", api_enabled: false },
    registrations: [],
  });
  if (plan.status !== "blocked") return;

  const onlyMissingPrefix =
    plan.blockers.length === 1 &&
    plan.blockers[0]?.code === "app-id-prefix-required" &&
    options.appIdPrefix == null &&
    plan.bundleIdentifier != null;
  if (!onlyMissingPrefix) {
    throw iosRemoteError(
      `Clerk Native Application readiness could not be completed safely. No local or remote setup changes were written:\n${formatBlockers(plan)}`,
      ERROR_CODE.IOS_SETUP_BLOCKED,
    );
  }

  throwUsageError(
    agentAppIdPrefixRequiredMessage(
      plan.bundleIdentifier!,
      appIdPrefixSuggestion(options.target, options.unverifiedAppIdPrefixSuggestion),
    ),
  );
}

export async function prepareIOSNativeRemoteSetup(
  options: PrepareIOSNativeRemoteSetupOptions,
  dependencies: {
    api?: IOSNativeRemoteAPI;
    prompts?: IOSNativeRemotePrompts;
  } = {},
): Promise<IOSNativeRemotePlan> {
  const api = dependencies.api ?? defaultAPI;
  const prompts = dependencies.prompts ?? defaultPrompts;
  let state: Awaited<ReturnType<typeof readRemoteState>>;
  try {
    state = await withSpinner("Auditing Clerk Native Application settings...", async () =>
      readRemoteState(options.applicationId, options.instanceId, api),
    );
  } catch (error) {
    log.debug(`Could not inspect Clerk Native Application settings: ${errorMessage(error)}`);
    rethrowKnownRemoteError(error);
    throw iosRemoteError(
      `Clerk Native Application settings could not be inspected. ${nativeSetupOutcome(options.applicationLinkChange)} Verify your application access and rerun clerk init.`,
      ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    );
  }
  let plan = buildIOSNativeRemotePlan({
    applicationId: options.applicationId,
    instanceId: options.instanceId,
    root: options.root,
    target: options.target,
    requestedAppIdPrefix: options.appIdPrefix,
    ...state,
  });

  const onlyMissingPrefix =
    plan.status === "blocked" &&
    plan.blockers.length === 1 &&
    plan.blockers[0]?.code === "app-id-prefix-required" &&
    options.appIdPrefix == null &&
    plan.bundleIdentifier != null;
  if (onlyMissingPrefix) {
    const suggestion = appIdPrefixSuggestion(
      options.target,
      options.unverifiedAppIdPrefixSuggestion,
    );
    if (options.agent) {
      throwUsageError(
        agentAppIdPrefixRequiredMessage(
          plan.bundleIdentifier!,
          suggestion,
          options.applicationLinkChange,
        ),
      );
    }
    const appIdPrefix = await prompts.appIdPrefix(plan.bundleIdentifier!, suggestion);
    plan = buildIOSNativeRemotePlan({
      applicationId: options.applicationId,
      instanceId: options.instanceId,
      root: options.root,
      target: options.target,
      requestedAppIdPrefix: appIdPrefix,
      ...state,
    });
  }

  if (plan.status === "blocked") {
    throw iosRemoteError(
      `Clerk Native Application readiness could not be completed safely. ${nativeSetupOutcome(options.applicationLinkChange)}\n${formatBlockers(plan)}\n  Review https://dashboard.clerk.com/~/native-applications`,
      ERROR_CODE.IOS_SETUP_BLOCKED,
    );
  }

  if (plan.status === "satisfied") {
    log.info(dim("Clerk Native API and iOS application registration are already configured."));
    return plan;
  }

  log.info("\nclerk init will make the following remote Clerk changes:\n");
  for (const action of plan.actions) log.info(`  ${yellow("REMOTE")}  ${action}`);
  log.info(
    dim(
      "\n  Remote changes are additive. clerk init will not update or delete an existing iOS registration.",
    ),
  );
  log.blank();

  if (options.agent && !options.yes) {
    throwUsageError(
      "Changing Clerk Native Application settings in agent mode requires explicit consent. Rerun with --yes after reviewing the plan.",
    );
  }
  if (!options.yes && !(await prompts.confirmChanges())) throwUserAbort();
  return plan;
}

async function reconciledPlan(
  plan: IOSNativeRemotePlan,
  api: IOSNativeRemoteAPI,
): Promise<IOSNativeRemotePlan> {
  const state = await readRemoteState(plan.applicationId, plan.instanceId, api);
  const reconciled = buildIOSNativeRemotePlan({
    applicationId: plan.applicationId,
    instanceId: plan.instanceId,
    target: {
      status: "selected",
      projectPath: "",
      targetId: "",
      targetName: "",
      bundleIdentifier: { status: "resolved", value: plan.bundleIdentifier! },
      appIdPrefix: plan.appIdPrefix
        ? { status: "resolved", source: "literal-entitlements", value: plan.appIdPrefix }
        : { status: "missing", source: "literal-entitlements", candidates: [] },
    },
    requestedAppIdPrefix: plan.appIdPrefix,
    ...state,
  });
  return { ...reconciled, localTarget: plan.localTarget };
}

function prefixEvidenceMatchesApprovedIdentity(
  approved: IOSNativeRemoteTargetSnapshot["appIdPrefix"],
  current: IOSSelectedNativeReadinessTarget["appIdPrefix"],
  appIdPrefix: string,
): boolean {
  if (approved.status === "conflicting") return false;
  if (approved.status === "resolved") {
    return (
      approved.value === appIdPrefix &&
      current.status === "resolved" &&
      current.value === appIdPrefix
    );
  }

  // A prefix explicitly confirmed by the user or inherited from an existing
  // Clerk registration need not become literal Xcode evidence. If evidence
  // appears after approval, however, it may only prove that same prefix.
  if (approved.candidates?.some((candidate) => candidate !== appIdPrefix)) return false;
  if (current.status === "conflicting") return false;
  if (current.status === "resolved") return current.value === appIdPrefix;
  return !(current.candidates?.some((candidate) => candidate !== appIdPrefix) ?? false);
}

function localTargetStillMatchesApprovedIdentity(
  plan: IOSNativeRemotePlan,
  current: IOSNativeReadinessTarget,
): boolean {
  const approved = plan.localTarget;
  if (
    !approved ||
    !plan.bundleIdentifier ||
    !plan.appIdPrefix ||
    approved.bundleIdentifier.status !== "resolved" ||
    approved.bundleIdentifier.value !== plan.bundleIdentifier ||
    current.status !== "selected" ||
    current.projectPath !== approved.projectPath ||
    current.targetId !== approved.targetId ||
    current.bundleIdentifier.status !== "resolved" ||
    current.bundleIdentifier.value !== plan.bundleIdentifier
  ) {
    return false;
  }
  return prefixEvidenceMatchesApprovedIdentity(
    approved.appIdPrefix,
    current.appIdPrefix,
    plan.appIdPrefix,
  );
}

async function revalidateLocalTargetBeforeRemoteMutation(
  plan: IOSNativeRemotePlan,
  targetReader: IOSNativeRemoteTargetReader,
): Promise<void> {
  if (!plan.localTarget) {
    throw iosRemoteError(
      "The approved Clerk Native Application plan does not identify the inspected Xcode target. No remote changes were made; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }

  let current: IOSNativeReadinessTarget;
  try {
    current = await withSpinner("Rechecking the selected Xcode target identity...", async () =>
      targetReader(plan.localTarget!),
    );
  } catch (error) {
    log.debug(`Could not recheck the selected Xcode target identity: ${errorMessage(error)}`);
    throw iosRemoteError(
      "The selected Xcode target identity could not be rechecked. No remote changes were made; rerun clerk init.",
      ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    );
  }

  if (!localTargetStillMatchesApprovedIdentity(plan, current)) {
    throw iosRemoteError(
      "The selected Xcode target identity changed after the approved preview. No remote changes were made; rerun clerk init to review the current Bundle ID and App ID Prefix.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
}

function revalidatedActionSetIsAuthorized(
  approved: IOSNativeRemotePlan,
  current: IOSNativeRemotePlan,
): boolean {
  if (
    current.status === "blocked" ||
    current.applicationId !== approved.applicationId ||
    current.instanceId !== approved.instanceId ||
    current.bundleIdentifier !== approved.bundleIdentifier ||
    current.appIdPrefix !== approved.appIdPrefix
  ) {
    return false;
  }
  // Concurrent completion is harmless. A newly-required action was never
  // shown in the approved preview and must force a fresh plan instead.
  if (approved.nativeApi === "satisfied" && current.nativeApi !== "satisfied") return false;
  if (approved.registration === "satisfied" && current.registration !== "satisfied") {
    return false;
  }
  return true;
}

function registrationRetryIdentity(
  plan: IOSNativeRemotePlan,
): IOSNativeRegistrationRetryIdentity | undefined {
  if (!plan.localTarget || !plan.bundleIdentifier || !plan.appIdPrefix) return undefined;
  return {
    applicationId: plan.applicationId,
    instanceId: plan.instanceId,
    bundleIdentifier: plan.bundleIdentifier,
    appIdPrefix: plan.appIdPrefix,
  };
}

export async function applyIOSNativeRemoteSetup(
  plan: IOSNativeRemotePlan,
  api: IOSNativeRemoteAPI = defaultAPI,
  targetReader: IOSNativeRemoteTargetReader = defaultTargetReader,
  registrationRetryStore: IOSNativeRegistrationRetryStore = cliStateIOSNativeRegistrationRetryStore,
): Promise<void> {
  if (plan.status === "blocked" || !plan.bundleIdentifier || !plan.appIdPrefix) {
    throw iosRemoteError(
      "The approved Clerk Native Application plan is incomplete. No remote changes were made; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }

  if (plan.registration === "required" || plan.nativeApi === "required") {
    await revalidateLocalTargetBeforeRemoteMutation(plan, targetReader);
  }

  const nativeAPIIdempotencyKey = `clerk-init-ios-native-api-${randomUUID()}`;
  const retryIdentity = registrationRetryIdentity(plan);
  let observedRegistrationRetryKey: string | undefined;

  if (retryIdentity) {
    try {
      observedRegistrationRetryKey =
        plan.registration === "required"
          ? await registrationRetryStore.getOrCreate(retryIdentity)
          : await registrationRetryStore.peek(retryIdentity);
    } catch (error) {
      log.debug(
        `Could not read or preserve the iOS registration retry state: ${errorMessage(error)}`,
      );
      throw iosRemoteError(
        "The iOS application registration retry state could not be read or preserved safely. The local setup remains intact, and no registration request was sent; verify CLI state directory access and rerun clerk init.",
      );
    }
  }

  // Acquire the stable registration generation before the authoritative
  // remote re-read. A second CLI that resumes after another invocation has
  // completed must observe that completion before deciding whether to POST.
  let currentPlan: IOSNativeRemotePlan;
  try {
    currentPlan = await withSpinner("Rechecking Clerk Native Application settings...", async () =>
      reconciledPlan(plan, api),
    );
  } catch (error) {
    log.debug(`Could not recheck Clerk Native Application settings: ${errorMessage(error)}`);
    rethrowKnownRemoteError(error);
    throw iosRemoteError(
      "Clerk Native Application settings could not be rechecked after the local setup. No remote changes were made; rerun clerk init.",
      ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    );
  }
  if (!revalidatedActionSetIsAuthorized(plan, currentPlan)) {
    throw iosRemoteError(
      "Clerk Native Application settings changed after the approved preview. No remote changes were made; rerun clerk init to review the new plan.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }

  // Register first so Native API is never enabled by this command without a
  // matching iOS application registration already present.
  if (currentPlan.registration === "required") {
    if (!retryIdentity) {
      throw iosRemoteError(
        "The approved Clerk Native Application plan cannot persist a safe registration retry. No remote changes were made; rerun clerk init.",
        ERROR_CODE.IOS_SETUP_PLAN_INVALID,
      );
    }
    if (!observedRegistrationRetryKey) {
      throw iosRemoteError(
        "The approved Clerk Native Application plan did not retain a safe registration retry. No registration request was sent; rerun clerk init.",
        ERROR_CODE.IOS_SETUP_PLAN_INVALID,
      );
    }
    try {
      const created = await withSpinner("Registering the iOS application with Clerk...", async () =>
        api.createIOSApplication(
          plan.applicationId,
          plan.instanceId,
          { appIdPrefix: plan.appIdPrefix!, bundleId: plan.bundleIdentifier! },
          { idempotencyKey: observedRegistrationRetryKey },
        ),
      );
      if (
        created.bundle_id !== plan.bundleIdentifier ||
        created.app_id_prefix !== plan.appIdPrefix
      ) {
        throw iosRemoteError(
          "Clerk returned an unexpected iOS application registration. The local setup remains intact; rerun clerk init to reconcile remote state.",
          ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
        );
      }
    } catch (error) {
      log.debug(`Could not create the iOS application registration: ${errorMessage(error)}`);
      let registrations: IOSApplication[];
      try {
        registrations = await api.listIOSApplications(plan.applicationId, plan.instanceId);
      } catch (fallbackError) {
        log.debug(
          `Could not confirm the iOS application registration: ${errorMessage(fallbackError)}`,
        );
        rethrowKnownRemoteError(fallbackError);
        throw iosRemoteError(
          "The iOS application registration could not be confirmed. The local setup remains intact; rerun clerk init to reconcile remote state.",
        );
      }
      const exact = registrations.some(
        (registration) =>
          registration.bundle_id === plan.bundleIdentifier &&
          registration.app_id_prefix === plan.appIdPrefix,
      );
      if (!exact) {
        rethrowKnownRemoteError(error);
        throw iosRemoteError(
          "The iOS application could not be registered with Clerk. The local setup remains intact; rerun clerk init to retry safely.",
        );
      }
    }
    log.success(`iOS application ${plan.bundleIdentifier} registered with Clerk`);
  }

  if (currentPlan.nativeApi === "required") {
    try {
      const enabled = await withSpinner("Enabling the Clerk Native API...", async () =>
        api.enableNativeApi(plan.applicationId, plan.instanceId, {
          idempotencyKey: nativeAPIIdempotencyKey,
        }),
      );
      if (!enabled.api_enabled) {
        throw iosRemoteError(
          "Clerk did not report the Native API as enabled. The local setup and any completed registration remain intact; rerun clerk init.",
          ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE,
        );
      }
    } catch (error) {
      log.debug(`Could not enable the Clerk Native API: ${errorMessage(error)}`);
      let current: NativeSettings;
      try {
        current = await api.getNativeSettings(plan.applicationId, plan.instanceId);
      } catch (fallbackError) {
        log.debug(`Could not confirm Clerk Native API state: ${errorMessage(fallbackError)}`);
        rethrowKnownRemoteError(fallbackError);
        throw iosRemoteError(
          "Native API enablement could not be confirmed. The local setup and any completed iOS registration remain intact; rerun clerk init.",
        );
      }
      if (!current.api_enabled) {
        rethrowKnownRemoteError(error);
        throw iosRemoteError(
          "The Native API could not be enabled. The local setup and any completed iOS registration remain intact; rerun clerk init to retry safely.",
        );
      }
    }
    log.success("Clerk Native API enabled for the development instance");
  }

  let finalPlan: IOSNativeRemotePlan;
  try {
    finalPlan = await withSpinner("Verifying Clerk Native Application settings...", async () =>
      reconciledPlan(plan, api),
    );
  } catch (error) {
    log.debug(`Could not verify Clerk Native Application settings: ${errorMessage(error)}`);
    rethrowKnownRemoteError(error);
    throw iosRemoteError(
      "Clerk Native Application settings could not be verified. The local setup and any completed remote changes remain intact; rerun clerk init.",
      ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    );
  }
  if (finalPlan.status !== "satisfied" || !revalidatedActionSetIsAuthorized(plan, finalPlan)) {
    throw iosRemoteError(
      "Clerk Native Application settings did not pass the final verification. The local iOS setup remains intact; rerun clerk init to reconcile the additive remote steps.",
      ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
    );
  }
  if (retryIdentity && observedRegistrationRetryKey) {
    try {
      const cleared = await registrationRetryStore.clear(
        retryIdentity,
        observedRegistrationRetryKey,
      );
      if (!cleared) {
        log.debug(
          "Preserved a newer iOS registration retry state created after this invocation began.",
        );
      }
    } catch (error) {
      log.debug(
        `Could not clear the verified iOS registration retry state: ${errorMessage(error)}`,
      );
      throw iosRemoteError(
        "Clerk Native Application settings were verified, but the local registration retry state could not be cleared. No further remote changes are required; verify CLI state directory access and rerun clerk init.",
        ERROR_CODE.IOS_REMOTE_VERIFY_FAILED,
      );
    }
  }
}
