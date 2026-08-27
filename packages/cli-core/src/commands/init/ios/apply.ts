import { lstat, realpath } from "node:fs/promises";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { dim, yellow } from "../../../lib/color.ts";
import {
  CliError,
  ERROR_CODE,
  type ErrorCode,
  throwUsageError,
  throwUserAbort,
} from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { confirm } from "../../../lib/prompts.ts";
import { withSpinner } from "../../../lib/spinner.ts";
import { inspectIOSProject } from "./inspect.ts";
import {
  planIOSSDKInstall,
  prepareIOSSDKInstallMutation,
  validateIOSSDKInstallPostcondition,
  type IOSSDKInstallPlan,
  type PreparedIOSSDKInstallMutation,
} from "./install-sdk.ts";
import { buildIOSSetupPlan, hasIOSRuntimeKeyHandoffShape } from "./plan.ts";
import { clerkKitUIInstallDecision, shouldPlanIOSDirectConfig } from "./products.ts";
import {
  planIOSDirectConfig,
  prepareIOSDirectConfigMutation,
  validatePreparedIOSDirectConfig,
  type IOSDirectConfigPlan,
  type IOSDirectConfigPreparedMutation,
} from "./direct-config.ts";
import {
  applyIOSExistingFileTransaction,
  applyIOSFileTransaction,
  type IOSExistingFileMutation,
  type IOSFileMutation,
} from "./file-transaction.ts";
import {
  applyIOSRuntimeKey,
  planIOSRuntimeKey,
  planIOSRuntimeKeyVerification,
  verifyIOSRuntimeKey,
  type IOSRuntimeKeyPlan,
  type IOSRuntimeKeyVerificationPlan,
} from "./runtime-key.ts";
import {
  planIOSAssociatedDomain,
  prepareIOSAssociatedDomainMutation,
  validatePreparedIOSAssociatedDomain,
  type IOSAssociatedDomainPlan,
  type PreparedIOSAssociatedDomainMutation,
} from "./associated-domain.ts";
import {
  planIOSAppleEntitlement,
  prepareIOSAppleEntitlementMutation,
  validatePreparedIOSAppleEntitlement,
  type IOSAppleEntitlementPlan,
  type PreparedIOSAppleEntitlementMutation,
} from "./apple-entitlement.ts";
import {
  buildIOSNativeReadinessAudit,
  suggestAppIdPrefixFromDevelopmentTeam,
  type IOSNativeReadinessAudit,
  type IOSUnverifiedAppIdPrefixSuggestion,
} from "./native-readiness.ts";
import {
  planIOSPrebuiltAuth,
  prepareIOSPrebuiltAuthMutation,
  validatePreparedIOSPrebuiltAuth,
  type IOSPrebuiltAuthPlan,
  type PreparedIOSPrebuiltAuthMutation,
} from "./prebuilt-auth.ts";

function iosSetupError(message: string, code: ErrorCode = ERROR_CODE.IOS_SETUP_BLOCKED): CliError {
  return new CliError(message, { code });
}

export interface ApplyIOSLocalSetupOptions {
  root: string;
  target?: string;
  yes: boolean;
  agent: boolean;
  allowDirty: boolean;
  /** Explicit native Apple opt-in. Undefined allows a human prompt. */
  signInWithApple?: boolean;
  /** Explicit prebuilt AuthView opt-in. Undefined allows a default-off human prompt. */
  prebuiltAuthUI?: boolean;
}

/** Read-only SDK compatibility planner shared by the AuthView dry-run path. */
export async function planIOSPrebuiltAuthSDKCompatibility(options: {
  root: string;
  projectPath: string;
  targetId: string;
}): Promise<IOSSDKInstallPlan> {
  return planIOSSDKInstall({
    ...options,
    includeClerkKitUI: true,
    requirePrebuiltAuthCompatibility: true,
  });
}

export interface IOSLocalSetupResult {
  targetName: string;
  /** Redacted local identity used to audit the linked instance after authentication. */
  nativeReadiness: IOSNativeReadinessAudit;
  /** Human-only Xcode signing-team suggestion; never treated as proven prefix evidence. */
  unverifiedAppIdPrefixSuggestion?: IOSUnverifiedAppIdPrefixSuggestion;
  sdkInstallPlan?: IOSSDKInstallPlan;
  /** Fresh/default direct Swift configuration or existing inline verification. */
  directConfigPlan?: IOSDirectConfigPlan;
  /** Pre-authorized, redacted plan whose key is resolved only after app linking. */
  runtimeKeyPlan?: IOSRuntimeKeyPlan;
  /** Read-only proof for comparing an already configured sink after app linking. */
  runtimeKeyVerificationPlan?: IOSRuntimeKeyVerificationPlan;
  /** Existing entitlements files that can receive the exact linked webcredentials host. */
  associatedDomainPlan?: IOSAssociatedDomainPlan;
  /** Selected-target Sign in with Apple entitlement setup or verification. */
  appleEntitlementPlan?: IOSAppleEntitlementPlan;
  /** Optional prebuilt AuthView source setup or exact generated-flow verification. */
  prebuiltAuthPlan?: IOSPrebuiltAuthPlan;
  /**
   * Pre-authorized local Apple capability candidate for the selected AuthView flow.
   * It is applied only when a later environment audit proves Apple is enabled.
   */
  prebuiltAuthAppleEntitlementPlan?: IOSAppleEntitlementPlan;
  /** Explicit flag or AuthView-specific human confirmation; never inferred from --yes. */
  prebuiltAuthRequested: boolean;
  /** Explicitly selected or byte-identical generated AuthView flow present on a rerun. */
  prebuiltAuthActive: boolean;
  /** Explicit flag or Apple-specific human confirmation; never inferred from --yes. */
  nativeAppleRequested: boolean;
  /** Authentication must return an exact app ID and development key before commit. */
  requiresLinkedApp: boolean;
  /** The approved local transaction consumes the linked development publishable key. */
  requiresDevelopmentKey: boolean;
  /** An existing runtime value must not be paired with an auto-created agent app. */
  verifiesExistingKey: boolean;
}

/** @internal Test-only hook used to prove aggregate post-write rollback. */
export interface ApplyIOSPlannedLocalSetupOptions {
  beforePostWriteValidation?: () => void | Promise<void>;
}

type GitPathState = "clean" | "dirty" | "not-repository" | "unknown";
const GIT_PATH_STATE_TIMEOUT_MS = 5_000;

async function hasGitMarkerInAncestors(start: string): Promise<boolean> {
  let directory = resolve(start);
  while (true) {
    try {
      await lstat(resolve(directory, ".git"));
      return true;
    } catch {
      // Keep walking until the filesystem root.
    }
    const parent = dirname(directory);
    if (parent === directory) return false;
    directory = parent;
  }
}

async function gitPathState(absolutePath: string): Promise<GitPathState> {
  const projectDirectory = dirname(absolutePath);
  try {
    const repository = Bun.spawn(["git", "rev-parse", "--show-toplevel"], {
      cwd: projectDirectory,
      stdout: "pipe",
      stderr: "ignore",
      timeout: GIT_PATH_STATE_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
    const repositoryRoot = (await new Response(repository.stdout).text()).trim();
    const repositoryExitCode = await repository.exited;
    if (repository.signalCode != null) return "unknown";
    if (repositoryExitCode !== 0) {
      return (await hasGitMarkerInAncestors(projectDirectory)) ? "unknown" : "not-repository";
    }
    if (repositoryRoot === "") return "unknown";

    const canonicalRepositoryRoot = await realpath(repositoryRoot);
    let canonicalAbsolutePath: string;
    try {
      canonicalAbsolutePath = await realpath(absolutePath);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
        return "unknown";
      }
      canonicalAbsolutePath = resolve(
        await realpath(dirname(absolutePath)),
        basename(absolutePath),
      );
    }
    const path = relative(canonicalRepositoryRoot, canonicalAbsolutePath);
    if (path === "" || path === ".." || path.startsWith(`..${sep}`)) return "unknown";

    const status = Bun.spawn(
      ["git", "status", "--porcelain=v1", "--untracked-files=all", "--", path],
      {
        cwd: canonicalRepositoryRoot,
        stdout: "pipe",
        stderr: "ignore",
        timeout: GIT_PATH_STATE_TIMEOUT_MS,
        killSignal: "SIGKILL",
      },
    );
    const output = await new Response(status.stdout).text();
    const statusExitCode = await status.exited;
    if (status.signalCode != null || statusExitCode !== 0) return "unknown";
    return output.trim() === "" ? "clean" : "dirty";
  } catch {
    return "unknown";
  }
}

function formatProducts(products: string[]): string {
  if (products.length === 1) return products[0]!;
  return `${products.slice(0, -1).join(", ")} and ${products.at(-1)}`;
}

function directConfigNeedsWrite(plan: IOSDirectConfigPlan | undefined): boolean {
  const changes = plan?.changes;
  return (
    plan?.status === "ready" &&
    changes != null &&
    (changes.clerkKitImport === "insert" ||
      changes.configuration !== "verify-existing" ||
      changes.environment === "insert")
  );
}

function associatedDomainNeedsWrite(
  plan: IOSAssociatedDomainPlan | undefined,
): plan is IOSAssociatedDomainPlan {
  return plan?.status === "ready";
}

function blockerList(blockers: Array<{ message: string }>): string {
  return blockers.map((blocker) => `  • ${blocker.message}`).join("\n");
}

export function planIOSPrebuiltAuthRuntimeBlockers(
  inspection: Awaited<ReturnType<typeof inspectIOSProject>>,
  directConfigPlan: IOSDirectConfigPlan | undefined,
  runtimeKeyPlan: IOSRuntimeKeyPlan | undefined,
): string[] {
  const setupPlan = buildIOSSetupPlan(inspection, { directConfigPlan, runtimeKeyPlan });
  const configureStep = setupPlan.steps.find((step) => step.id === "configure-publishable-key");
  const environmentStep = setupPlan.steps.find((step) => step.id === "inject-clerk-environment");
  const directConfigurationReady =
    directConfigPlan?.status === "ready" && configureStep?.automatable === true;
  const runtimeKeyConfigurationReady =
    runtimeKeyPlan?.status === "ready" && configureStep?.automatable === true;
  const directEnvironmentReady =
    directConfigPlan?.status === "ready" &&
    (directConfigPlan.changes?.environment === "insert" ||
      directConfigPlan.changes?.environment === "satisfied");
  const blockers: string[] = [];

  if (
    configureStep?.status !== "satisfied" &&
    !directConfigurationReady &&
    !runtimeKeyConfigurationReady
  ) {
    blockers.push(
      "Clerk.configure(publishableKey:) is neither proven at runtime nor included in the safe direct-configuration plan.",
    );
  }
  if (environmentStep?.status !== "satisfied" && !directEnvironmentReady) {
    blockers.push(
      "Clerk.shared is not proven in the shipping SwiftUI root environment, and the existing runtime abstraction cannot be rewritten safely.",
    );
  }

  return blockers;
}

async function validatePrebuiltAuthRuntimePostcondition(
  setup: IOSLocalSetupResult,
  allowPendingRuntimeKey: boolean,
): Promise<boolean> {
  if (!setup.prebuiltAuthActive) return true;
  if (setup.nativeReadiness.target.status !== "selected") return false;
  const target = setup.nativeReadiness.target;
  const inspection = await inspectIOSProject(setup.nativeReadiness.root, {
    target: target.targetId,
  });
  const setupPlan = buildIOSSetupPlan(inspection, {
    runtimeKeyPlan: allowPendingRuntimeKey ? setup.runtimeKeyPlan : undefined,
  });
  const configureStep = setupPlan.steps.find((step) => step.id === "configure-publishable-key");
  const environmentStep = setupPlan.steps.find((step) => step.id === "inject-clerk-environment");
  const configurationReady =
    configureStep?.status === "satisfied" ||
    (allowPendingRuntimeKey &&
      setup.runtimeKeyPlan?.status === "ready" &&
      configureStep?.automatable === true);

  return configurationReady && environmentStep?.status === "satisfied";
}

/**
 * Inspects, previews, and authorizes the local iOS setup without writing it.
 * The returned redacted plans are prepared again and committed only after an
 * exact Clerk application and development publishable key have been resolved.
 */
export async function applyIOSLocalSetup(
  options: ApplyIOSLocalSetupOptions,
): Promise<IOSLocalSetupResult> {
  const inspection = await withSpinner("Inspecting Xcode project...", async () =>
    inspectIOSProject(options.root, { target: options.target }),
  );
  const selection = inspection.selection;
  if (selection.state !== "selected") {
    if (selection.state === "ambiguous") {
      const candidates = selection.candidates
        .map(
          (candidate) =>
            `${candidate.targetName} (${candidate.targetId}, ${candidate.projectPath})`,
        )
        .join(", ");
      throwUsageError(
        `More than one iOS application target is eligible: ${candidates}. Rerun with --target <name-or-id>; if IDs collide across copied projects, run the command from the intended project's directory.`,
      );
    }
    if (selection.state === "not-found") {
      throwUsageError(
        `The iOS target "${selection.requested}" was not found. Available targets: ${selection.candidates.join(", ") || "none"}.`,
      );
    }
    throw iosSetupError(
      "No usable iOS application target was found.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }

  const selectedTarget = inspection.appTargets.find(
    (target) => target.id === selection.targetId && target.projectPath === selection.projectPath,
  );
  if (!selectedTarget) {
    throw iosSetupError(
      "The selected iOS target could not be resolved safely.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
  const unverifiedAppIdPrefixSuggestion = suggestAppIdPrefixFromDevelopmentTeam(selectedTarget);
  const productDecision = clerkKitUIInstallDecision(selectedTarget);
  if (productDecision === "unknown") {
    throw iosSetupError(
      "The selected target's Swift source membership could not be inspected completely, so Clerk cannot safely choose between the prebuilt ClerkKitUI path and a core-only custom flow. Resolve the Xcode source-membership diagnostics, then rerun clerk init.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
  const inspectedPrebuiltAuthPlan = await planIOSPrebuiltAuth({
    root: options.root,
    projectPath: selection.projectPath,
    targetId: selection.targetId,
    allowDirty: options.allowDirty,
  });
  let prebuiltAuthRequested = options.prebuiltAuthUI === true;
  if (
    !prebuiltAuthRequested &&
    options.prebuiltAuthUI == null &&
    inspectedPrebuiltAuthPlan.status === "ready" &&
    !options.agent &&
    !options.yes
  ) {
    prebuiltAuthRequested = await confirm({
      message: `Add ClerkKitUI's prebuilt authentication UI to ${selection.targetName}?`,
      default: false,
    });
  }
  if (prebuiltAuthRequested && inspectedPrebuiltAuthPlan.status === "blocked") {
    throw iosSetupError(
      `The prebuilt AuthView flow could not be added safely. No local files were changed:\n${blockerList(inspectedPrebuiltAuthPlan.blockers)}`,
    );
  }
  const prebuiltAuthActive =
    prebuiltAuthRequested || inspectedPrebuiltAuthPlan.status === "satisfied";
  const prebuiltAuthPlan = prebuiltAuthActive ? inspectedPrebuiltAuthPlan : undefined;

  // A source-proven custom flow remains core-only by default, but an explicit
  // or interactive AuthView selection must link the product that generated
  // source imports before the aggregate transaction is authorized.
  const includeClerkKitUI = productDecision === "prebuilt" || prebuiltAuthActive;

  const installPlan = await planIOSSDKInstall({
    root: options.root,
    projectPath: selection.projectPath,
    targetId: selection.targetId,
    includeClerkKitUI,
    requirePrebuiltAuthCompatibility: prebuiltAuthActive,
  });

  const configureStep = buildIOSSetupPlan(inspection).steps.find(
    (candidate) => candidate.id === "configure-publishable-key",
  );
  const needsRuntimeKeyHandoff =
    configureStep?.status === "required" &&
    hasIOSRuntimeKeyHandoffShape(inspection, selectedTarget);
  const plannedRuntimeKey = needsRuntimeKeyHandoff
    ? await planIOSRuntimeKey({
        root: options.root,
        projectPath: selection.projectPath,
        targetId: selection.targetId,
      })
    : undefined;
  const runtimeKeyPlan = plannedRuntimeKey?.status === "ready" ? plannedRuntimeKey : undefined;
  const hasSatisfiedLocalRuntimeSink =
    configureStep?.status === "satisfied" &&
    inspection.localPublishableKey.source != null &&
    selectedTarget.runtimeKeySinks.some(
      (sink) => sink.path === inspection.localPublishableKey.source,
    );
  const plannedRuntimeKeyVerification = hasSatisfiedLocalRuntimeSink
    ? await planIOSRuntimeKeyVerification({
        root: options.root,
        projectPath: selection.projectPath,
        targetId: selection.targetId,
      })
    : undefined;
  const runtimeKeyVerificationPlan =
    plannedRuntimeKeyVerification?.status === "ready" ? plannedRuntimeKeyVerification : undefined;
  const hasLocalSecretsConfigure = selectedTarget.swift.configureCalls.some(
    (call) => call.publishableKeyWiring === "local-secrets-loader",
  );
  const hasEnabledSchemeKey = inspection.localPublishableKey.candidateSources.some((source) =>
    source.endsWith(".xcscheme"),
  );
  const shouldPlanDirectConfig = shouldPlanIOSDirectConfig(
    inspection,
    selectedTarget,
    prebuiltAuthActive ? "prebuilt" : productDecision,
  );
  const directConfigPlan = shouldPlanDirectConfig
    ? await planIOSDirectConfig({
        root: options.root,
        projectPath: selection.projectPath,
        targetId: selection.targetId,
        allowDirty: options.allowDirty,
      })
    : undefined;
  if (
    directConfigNeedsWrite(directConfigPlan) &&
    prebuiltAuthPlan?.status === "ready" &&
    directConfigPlan?.sourcePath === prebuiltAuthPlan.sourcePath
  ) {
    throw iosSetupError(
      "The approved iOS setup resolved the Clerk initializer and prebuilt AuthView scaffold to the same Swift source unexpectedly. No local files were changed; review the app root and rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const plannedAssociatedDomain = await planIOSAssociatedDomain({
    root: options.root,
    projectPath: selection.projectPath,
    targetId: selection.targetId,
    deferToPublishableKey: directConfigPlan?.status === "ready",
    // A LocalSecrets write is a specialized secret transaction that cannot
    // yet share rollback ownership with a newly created entitlements file.
    allowMissingEntitlementsCreation: runtimeKeyPlan == null,
  });
  // Associated Domains is an independent additive improvement. Unsupported
  // or ambiguous entitlements must not prevent the already-proven SDK/source
  // setup; those cases remain an actionable manual step in the final plan.
  const associatedDomainPlan =
    plannedAssociatedDomain.status === "blocked" ? undefined : plannedAssociatedDomain;
  const nativeReadiness = buildIOSNativeReadinessAudit(inspection, {
    associatedDomainPlan: plannedAssociatedDomain,
  });
  if (
    nativeReadiness.target.status !== "selected" ||
    nativeReadiness.target.bundleIdentifier.status !== "resolved"
  ) {
    throw iosSetupError(
      "The selected iOS target does not have one proven Bundle ID across all build configurations. No local files were changed; resolve PRODUCT_BUNDLE_IDENTIFIER, then rerun clerk init.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
  const hasLocalAppleEntitlement = selectedTarget.configurations.some(
    (configuration) => configuration.entitlements?.signInWithApple === true,
  );
  let nativeAppleRequested = options.signInWithApple === true;
  if (!nativeAppleRequested && options.signInWithApple == null && !options.agent && !options.yes) {
    nativeAppleRequested = await confirm({
      message: `Enable native Sign in with Apple for ${nativeReadiness.target.bundleIdentifier.value}?`,
      default: false,
    });
  }
  const inspectedAppleEntitlementPlan =
    nativeAppleRequested || hasLocalAppleEntitlement || prebuiltAuthActive
      ? await planIOSAppleEntitlement({
          root: options.root,
          projectPath: selection.projectPath,
          targetId: selection.targetId,
          // New entitlements creation cannot be rolled back through the
          // specialized LocalSecrets transaction.
          allowMissingEntitlementsCreation: runtimeKeyPlan == null,
        })
      : undefined;
  // Existing entitlement evidence remains available for a read-only satisfied
  // verification, but incomplete local Apple setup is never completed unless
  // this invocation explicitly opted into the strategy.
  const appleEntitlementPlan = nativeAppleRequested
    ? inspectedAppleEntitlementPlan
    : inspectedAppleEntitlementPlan?.status === "satisfied"
      ? inspectedAppleEntitlementPlan
      : undefined;
  const prebuiltAuthAppleEntitlementPlan = prebuiltAuthActive
    ? inspectedAppleEntitlementPlan
    : undefined;
  if (appleEntitlementPlan?.status === "blocked") {
    throw iosSetupError(
      `Native Sign in with Apple could not be configured safely. No local files were changed:\n${blockerList(appleEntitlementPlan.blockers)}`,
    );
  }
  const reviewOnlyUnattributedInstall =
    !prebuiltAuthActive &&
    installPlan.requirePrebuiltAuthCompatibility !== true &&
    installPlan.status === "blocked" &&
    installPlan.blockers.length > 0 &&
    installPlan.blockers.every((blocker) => blocker.code === "unattributed-product") &&
    installPlan.products.every((product) =>
      product === "ClerkKit"
        ? selectedTarget.packages.clerkKit === "linked"
        : selectedTarget.packages.clerkKitUI === "linked",
    );
  const sdkInstallPlan = reviewOnlyUnattributedInstall ? undefined : installPlan;

  if (plannedRuntimeKeyVerification?.status === "blocked") {
    throw iosSetupError(
      `The existing iOS runtime publishable key could not be verified safely. No local files were changed:\n${blockerList(plannedRuntimeKeyVerification.blockers)}`,
    );
  }
  if (plannedRuntimeKey?.status === "blocked") {
    throw iosSetupError(
      `The development publishable key could not be wired safely. No local files were changed:\n${blockerList(plannedRuntimeKey.blockers)}`,
    );
  }
  if (directConfigPlan?.status === "blocked") {
    throw iosSetupError(
      `The selected SwiftUI app could not be configured automatically. No local files were changed:\n${blockerList(directConfigPlan.blockers)}`,
    );
  }
  if (
    (productDecision === "prebuilt" || prebuiltAuthActive) &&
    selectedTarget.swift.configureCalls.length === 0 &&
    !directConfigPlan &&
    !runtimeKeyPlan
  ) {
    const reason = hasEnabledSchemeKey
      ? "an enabled Run-scheme publishable key already indicates a custom runtime configuration"
      : selectedTarget.runtimeKeySinks.length > 0
        ? "a target-owned LocalSecrets.plist exists without a proven loader"
        : "the selected runtime configuration could not be proven";
    throw iosSetupError(
      `The fresh SwiftUI target was not edited because ${reason}. Resolve that setup or configure Clerk directly in the @main initializer, then rerun clerk init. No local files were changed.`,
    );
  }
  if (hasLocalSecretsConfigure && !runtimeKeyPlan && !runtimeKeyVerificationPlan) {
    throw iosSetupError(
      "An existing LocalSecrets-based Clerk configuration was found, but its selected-target runtime sink could not be proven. No local files were changed; repair or confirm that compatibility path manually.",
    );
  }
  if (prebuiltAuthActive) {
    const runtimeBlockers = planIOSPrebuiltAuthRuntimeBlockers(
      inspection,
      directConfigPlan,
      runtimeKeyPlan,
    );
    if (runtimeBlockers.length > 0) {
      throw iosSetupError(
        `The prebuilt AuthView flow requires a proven Clerk runtime and SwiftUI environment before its source can be added. No local files were changed:\n${runtimeBlockers
          .map((message) => `  • ${message}`)
          .join("\n")}`,
      );
    }
  }

  if (installPlan.status === "satisfied") {
    const verb = installPlan.products.length === 1 ? "is" : "are";
    log.info(
      dim(
        `\n${formatProducts(installPlan.products)} ${verb} already linked to ${selection.targetName}.`,
      ),
    );
  }
  if (reviewOnlyUnattributedInstall) {
    const verb = installPlan.products.length === 1 ? "is" : "are";
    log.info(
      dim(
        `\n${formatProducts(installPlan.products)} ${verb} already linked to ${selection.targetName}, but package attribution is not represented in this project graph. The existing Xcode package graph will be left unchanged.`,
      ),
    );
  } else if (installPlan.status === "blocked") {
    throw iosSetupError(
      `The Clerk iOS SDK could not be installed automatically:\n${blockerList(installPlan.blockers)}`,
    );
  }
  const plannedPaths: Array<{ absolutePath: string; displayPath: string }> = [];
  if (installPlan.status === "ready") {
    plannedPaths.push({
      absolutePath: resolve(options.root, selection.projectPath, "project.pbxproj"),
      displayPath: `${selection.projectPath}/project.pbxproj`,
    });
  }
  if (runtimeKeyPlan?.localSecretsPath) {
    plannedPaths.push({
      absolutePath: resolve(options.root, runtimeKeyPlan.localSecretsPath),
      displayPath: runtimeKeyPlan.localSecretsPath,
    });
  }
  const changesGitignore = runtimeKeyPlan?.changesGitignore === true;
  if (changesGitignore && runtimeKeyPlan?.gitignorePath) {
    plannedPaths.push({
      absolutePath: resolve(options.root, runtimeKeyPlan.gitignorePath),
      displayPath: runtimeKeyPlan.gitignorePath,
    });
  }
  if (directConfigNeedsWrite(directConfigPlan) && directConfigPlan?.sourcePath) {
    plannedPaths.push({
      absolutePath: resolve(options.root, directConfigPlan.sourcePath),
      displayPath: directConfigPlan.sourcePath,
    });
  }
  if (prebuiltAuthPlan?.status === "ready" && prebuiltAuthPlan.sourcePath) {
    plannedPaths.push({
      absolutePath: resolve(options.root, prebuiltAuthPlan.sourcePath),
      displayPath: prebuiltAuthPlan.sourcePath,
    });
  }
  if (associatedDomainNeedsWrite(associatedDomainPlan)) {
    if (associatedDomainPlan.missingEntitlementsSettings) {
      plannedPaths.push({
        absolutePath: resolve(options.root, selection.projectPath, "project.pbxproj"),
        displayPath: `${selection.projectPath}/project.pbxproj`,
      });
    }
    for (const file of associatedDomainPlan.files) {
      plannedPaths.push({
        absolutePath: resolve(options.root, file.path),
        displayPath: file.path,
      });
    }
  }
  if (appleEntitlementPlan?.status === "ready") {
    if (appleEntitlementPlan.missingEntitlementsSettings) {
      plannedPaths.push({
        absolutePath: resolve(options.root, selection.projectPath, "project.pbxproj"),
        displayPath: `${selection.projectPath}/project.pbxproj`,
      });
    }
    for (const file of appleEntitlementPlan.files) {
      plannedPaths.push({
        absolutePath: resolve(options.root, file.path),
        displayPath: file.path,
      });
    }
  }
  if (
    prebuiltAuthAppleEntitlementPlan?.status === "ready" &&
    prebuiltAuthAppleEntitlementPlan !== appleEntitlementPlan
  ) {
    if (prebuiltAuthAppleEntitlementPlan.missingEntitlementsSettings) {
      plannedPaths.push({
        absolutePath: resolve(options.root, selection.projectPath, "project.pbxproj"),
        displayPath: `${selection.projectPath}/project.pbxproj`,
      });
    }
    for (const file of prebuiltAuthAppleEntitlementPlan.files) {
      plannedPaths.push({
        absolutePath: resolve(options.root, file.path),
        displayPath: file.path,
      });
    }
  }
  if (!options.allowDirty) {
    const uniquePaths = [
      ...new Map(plannedPaths.map((path) => [path.absolutePath, path])).values(),
    ];
    for (const path of uniquePaths) {
      const state = await gitPathState(path.absolutePath);
      if (state === "dirty") {
        throw iosSetupError(
          `${path.displayPath} already has local changes. Commit or stash them, or rerun with --allow-dirty to preserve and build on those exact bytes.`,
          ERROR_CODE.IOS_WORKTREE_UNSAFE,
        );
      }
      if (state === "unknown") {
        throw iosSetupError(
          `Git could not verify whether ${path.displayPath} has local changes. Resolve the Git error, or rerun with --allow-dirty to build on the current exact bytes.`,
          ERROR_CODE.IOS_WORKTREE_UNSAFE,
        );
      }
    }
  }

  const hasLocalWrites =
    installPlan.status === "ready" ||
    runtimeKeyPlan != null ||
    directConfigNeedsWrite(directConfigPlan) ||
    prebuiltAuthPlan?.status === "ready" ||
    associatedDomainNeedsWrite(associatedDomainPlan) ||
    appleEntitlementPlan?.status === "ready" ||
    prebuiltAuthAppleEntitlementPlan?.status === "ready";
  if (hasLocalWrites) {
    log.info("\nclerk init will make the following local iOS changes:\n");
  } else if (
    directConfigPlan ||
    runtimeKeyVerificationPlan ||
    appleEntitlementPlan ||
    prebuiltAuthPlan
  ) {
    log.info("\nclerk init will perform the following read-only iOS verification:\n");
  }
  if (installPlan.status === "ready") {
    log.info(`  ${yellow("MODIFY")}  ${selection.projectPath}/project.pbxproj`);
    for (const action of installPlan.actions) log.info(`          ${action}`);
  }
  if (runtimeKeyPlan) {
    if (changesGitignore && runtimeKeyPlan.gitignorePath) {
      const operation = runtimeKeyPlan.expectedGitignoreHash == null ? "CREATE" : "MODIFY";
      log.info(`  ${yellow(operation)}  ${runtimeKeyPlan.gitignorePath}`);
    }
    log.info(`  ${yellow("MODIFY")}  ${runtimeKeyPlan.localSecretsPath}`);
    for (const action of runtimeKeyPlan.actions) log.info(`          ${action}`);
    log.info(
      dim(
        "          The linked development publishable key will be fetched after authentication and will never be printed.",
      ),
    );
  }
  if (directConfigPlan) {
    const operation = directConfigNeedsWrite(directConfigPlan) ? "MODIFY" : "VERIFY";
    log.info(`  ${yellow(operation)}  ${directConfigPlan.sourcePath}`);
    for (const action of directConfigPlan.actions) log.info(`          ${action}`);
    log.info(
      dim(
        "          The linked development publishable key will remain in memory and is redacted from the preview and command output.",
      ),
    );
  }
  if (prebuiltAuthPlan) {
    const operation = prebuiltAuthPlan.status === "ready" ? "MODIFY" : "VERIFY";
    log.info(`  ${yellow(operation)}  ${prebuiltAuthPlan.sourcePath}`);
    for (const action of prebuiltAuthPlan.actions) log.info(`          ${action}`);
  }
  if (associatedDomainNeedsWrite(associatedDomainPlan)) {
    if (associatedDomainPlan.missingEntitlementsSettings && installPlan.status !== "ready") {
      log.info(`  ${yellow("MODIFY")}  ${selection.projectPath}/project.pbxproj`);
    }
    for (const file of associatedDomainPlan.files) {
      log.info(`  ${yellow(file.operation === "create" ? "CREATE" : "MODIFY")}  ${file.path}`);
    }
    for (const action of associatedDomainPlan.actions) log.info(`          ${action}`);
    if (associatedDomainPlan.requiresPublishableKey) {
      log.info(
        dim(
          "          The exact linked development host will be resolved after authentication and is redacted from this preview.",
        ),
      );
    }
  }
  if (appleEntitlementPlan?.status === "ready") {
    const alreadyPreviewedEntitlements = new Set(
      associatedDomainNeedsWrite(associatedDomainPlan)
        ? associatedDomainPlan.files.map((file) => file.path)
        : [],
    );
    if (
      appleEntitlementPlan.missingEntitlementsSettings &&
      installPlan.status !== "ready" &&
      !associatedDomainPlan?.missingEntitlementsSettings
    ) {
      log.info(`  ${yellow("MODIFY")}  ${selection.projectPath}/project.pbxproj`);
    }
    for (const file of appleEntitlementPlan.files) {
      if (!alreadyPreviewedEntitlements.has(file.path)) {
        log.info(`  ${yellow(file.operation === "create" ? "CREATE" : "MODIFY")}  ${file.path}`);
      }
    }
    for (const action of appleEntitlementPlan.actions) log.info(`          ${action}`);
  } else if (appleEntitlementPlan?.status === "satisfied") {
    log.info(dim("\n  The selected target already has the native Sign in with Apple entitlement."));
  }
  if (
    prebuiltAuthAppleEntitlementPlan?.status === "ready" &&
    prebuiltAuthAppleEntitlementPlan !== appleEntitlementPlan
  ) {
    log.info(
      dim(
        "\n  Conditional AuthView capability change (only if Apple is enabled for the linked instance):",
      ),
    );
    const alreadyPreviewedPaths = new Set<string>();
    if (installPlan.status === "ready") {
      alreadyPreviewedPaths.add(`${selection.projectPath}/project.pbxproj`);
    }
    if (associatedDomainNeedsWrite(associatedDomainPlan)) {
      if (associatedDomainPlan.missingEntitlementsSettings) {
        alreadyPreviewedPaths.add(`${selection.projectPath}/project.pbxproj`);
      }
      for (const file of associatedDomainPlan.files) alreadyPreviewedPaths.add(file.path);
    }
    if (prebuiltAuthAppleEntitlementPlan.missingEntitlementsSettings) {
      const projectFile = `${selection.projectPath}/project.pbxproj`;
      if (!alreadyPreviewedPaths.has(projectFile)) {
        log.info(`  ${yellow("MODIFY")}  ${projectFile}`);
      }
    }
    for (const file of prebuiltAuthAppleEntitlementPlan.files) {
      if (!alreadyPreviewedPaths.has(file.path)) {
        log.info(`  ${yellow(file.operation === "create" ? "CREATE" : "MODIFY")}  ${file.path}`);
      }
    }
    for (const action of prebuiltAuthAppleEntitlementPlan.actions) {
      log.info(`          If Apple is enabled: ${action}`);
    }
  }
  if (prebuiltAuthActive) {
    log.info(
      dim(
        "\n  After authentication, clerk init will inspect the methods available to AuthView. If Apple is enabled for this instance, it will add or verify the required local Sign in with Apple entitlement without enabling or changing the Clerk Apple connection.",
      ),
    );
  }
  if (installPlan.status === "ready") {
    log.info(dim("\n  Package resolution and xcodebuild will not run."));
  }
  log.info(
    dim(
      nativeAppleRequested
        ? "\n  After authentication, clerk init will inspect Native API, iOS registration, and the native Apple connection before separately previewing additive remote changes."
        : "\n  After authentication, clerk init will inspect Native API and iOS registration state and separately preview any additive remote changes.",
    ),
  );
  log.blank();

  if (hasLocalWrites && options.agent && !options.yes) {
    throwUsageError(
      "Changing an Xcode project in agent mode requires explicit consent. Review `clerk init --dry-run`, then rerun `clerk init --yes`.",
    );
  }
  if (hasLocalWrites && !options.yes) {
    const proceed = await confirm({ message: "Apply these local iOS changes?", default: false });
    if (!proceed) throwUserAbort();
  }

  return {
    targetName: selection.targetName,
    nativeReadiness,
    ...(unverifiedAppIdPrefixSuggestion ? { unverifiedAppIdPrefixSuggestion } : {}),
    sdkInstallPlan,
    directConfigPlan,
    runtimeKeyPlan,
    runtimeKeyVerificationPlan,
    associatedDomainPlan,
    appleEntitlementPlan,
    prebuiltAuthPlan,
    prebuiltAuthAppleEntitlementPlan,
    prebuiltAuthRequested,
    prebuiltAuthActive,
    nativeAppleRequested,
    requiresLinkedApp: true,
    requiresDevelopmentKey:
      directConfigPlan != null ||
      runtimeKeyPlan != null ||
      runtimeKeyVerificationPlan != null ||
      associatedDomainPlan?.requiresPublishableKey === true,
    verifiesExistingKey:
      directConfigPlan?.changes?.configuration === "verify-existing" ||
      runtimeKeyVerificationPlan != null,
  };
}

function directFileMutation(
  prepared: Extract<IOSDirectConfigPreparedMutation, { status: "ready" }>,
): IOSExistingFileMutation {
  return {
    path: prepared.mutation.absolutePath,
    originalBytes: prepared.mutation.originalBytes,
    originalHash: prepared.mutation.expectedHash,
    candidateBytes: prepared.mutation.candidateBytes,
    candidateHash: prepared.mutation.candidateHash,
    mode: prepared.mutation.mode,
  };
}

function prebuiltAuthFileMutation(
  prepared: Extract<PreparedIOSPrebuiltAuthMutation, { status: "ready" }>,
): IOSExistingFileMutation {
  return {
    path: prepared.mutation.absolutePath,
    originalBytes: prepared.mutation.originalBytes,
    originalHash: prepared.mutation.expectedHash,
    candidateBytes: prepared.mutation.candidateBytes,
    candidateHash: prepared.mutation.candidateHash,
    mode: prepared.mutation.mode,
  };
}

function reverseFileMutation(mutation: IOSExistingFileMutation): IOSExistingFileMutation {
  return {
    path: mutation.path,
    originalBytes: mutation.candidateBytes,
    originalHash: mutation.candidateHash,
    candidateBytes: mutation.originalBytes,
    candidateHash: mutation.originalHash,
    mode: mutation.mode,
  };
}

function preparedSDKBlockers(prepared: PreparedIOSSDKInstallMutation): string {
  return prepared.status === "blocked" ? blockerList(prepared.plan.blockers) : "";
}

async function prepareSDKForCommit(
  plan: IOSSDKInstallPlan | undefined,
): Promise<PreparedIOSSDKInstallMutation | undefined> {
  if (!plan) return undefined;
  const prepared = await prepareIOSSDKInstallMutation(plan);
  if (prepared.status === "stale") {
    throw iosSetupError(
      "The Xcode project changed after the preview. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (prepared.status === "blocked") {
    throw iosSetupError(
      `The Clerk iOS SDK could no longer be prepared safely. No local setup changes were written:\n${preparedSDKBlockers(prepared)}`,
    );
  }
  return prepared;
}

async function preparePrebuiltAuthForCommit(
  plan: IOSPrebuiltAuthPlan | undefined,
): Promise<PreparedIOSPrebuiltAuthMutation | undefined> {
  if (!plan) return undefined;
  const prepared = await prepareIOSPrebuiltAuthMutation(plan);
  if (prepared.status === "stale") {
    throw iosSetupError(
      "The Swift authentication view changed after the preview. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (prepared.status === "blocked") {
    throw iosSetupError(
      `The prebuilt AuthView flow could no longer be prepared safely. No local setup changes were written:\n${blockerList(prepared.plan.blockers)}`,
    );
  }
  return prepared;
}

async function prepareAssociatedDomainForCommit(
  plan: IOSAssociatedDomainPlan | undefined,
  publishableKey: string | undefined,
  basePbxMutation?: IOSExistingFileMutation,
): Promise<PreparedIOSAssociatedDomainMutation | undefined> {
  if (!plan) return undefined;
  const prepared = await prepareIOSAssociatedDomainMutation(plan, publishableKey, {
    basePbxMutation,
  });
  if (prepared.status === "stale") {
    throw iosSetupError(
      "An entitlements file changed after the preview. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (prepared.status === "blocked") {
    const reasons = blockerList(prepared.plan.blockers);
    throw iosSetupError(
      `The Clerk Associated Domain could no longer be prepared safely. No local setup changes were written${reasons ? `:\n${reasons}` : "."}`,
    );
  }
  return prepared;
}

async function prepareAppleEntitlementForCommit(
  plan: IOSAppleEntitlementPlan | undefined,
  baseMutations: readonly IOSFileMutation[],
): Promise<PreparedIOSAppleEntitlementMutation | undefined> {
  if (!plan) return undefined;
  const prepared = await prepareIOSAppleEntitlementMutation(plan, { baseMutations });
  if (prepared.status === "stale") {
    throw iosSetupError(
      "An iOS entitlements file changed after the Sign in with Apple preview. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (prepared.status === "blocked") {
    throw iosSetupError(
      `The Sign in with Apple entitlement could no longer be prepared safely. No local setup changes were written:\n${blockerList(prepared.plan.blockers)}`,
    );
  }
  return prepared;
}

function composeAppleMutations(
  baseMutations: readonly IOSFileMutation[],
  prepared: PreparedIOSAppleEntitlementMutation | undefined,
): IOSFileMutation[] {
  if (prepared?.status !== "ready") return [...baseMutations];
  const consumed = new Set(prepared.consumedBaseMutationPaths);
  return [
    ...baseMutations.filter((mutation) => !consumed.has(resolve(mutation.path))),
    ...prepared.mutations,
  ];
}

function existingMutationsOnly(mutations: readonly IOSFileMutation[]): IOSExistingFileMutation[] {
  if (mutations.some((mutation) => "kind" in mutation && mutation.kind === "create")) {
    throw iosSetupError(
      "The approved iOS setup attempted to combine incompatible runtime and file-creation transactions. No additional local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  return mutations as IOSExistingFileMutation[];
}

function assertUniqueMutationPaths(mutations: readonly IOSFileMutation[]): void {
  const paths = mutations.map((mutation) => resolve(mutation.path));
  if (new Set(paths).size !== paths.length) {
    throw iosSetupError(
      "The approved iOS setup produced overlapping file mutations. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
}

async function validateSatisfiedAssociatedDomain(plan: IOSAssociatedDomainPlan): Promise<boolean> {
  const current = await planIOSAssociatedDomain({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
  });
  return (
    current.status === "satisfied" &&
    (plan.expectedDomain == null || current.expectedDomain === plan.expectedDomain)
  );
}

async function validateSatisfiedAppleEntitlement(plan: IOSAppleEntitlementPlan): Promise<boolean> {
  const current = await planIOSAppleEntitlement({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
  });
  return current.status === "satisfied";
}

async function validateSatisfiedPrebuiltAuth(plan: IOSPrebuiltAuthPlan): Promise<boolean> {
  const current = await planIOSPrebuiltAuth({
    root: plan.root,
    projectPath: plan.projectPath,
    targetId: plan.targetId,
    allowDirty: true,
  });
  return current.status === "satisfied" && current.sourcePath === plan.sourcePath;
}

async function rollbackPreparedLocalMutations(
  mutations: readonly IOSExistingFileMutation[],
): Promise<void> {
  if (mutations.length === 0) return;
  const result = await applyIOSExistingFileTransaction(
    [...mutations].reverse().map(reverseFileMutation),
    [],
  );
  if (result.status !== "applied") {
    throw iosSetupError(
      "The publishable-key update failed, and a concurrent local edit prevented the approved iOS setup from being restored completely. Inspect the previewed project and entitlements files before retrying.",
      ERROR_CODE.IOS_LOCAL_ROLLBACK_FAILED,
    );
  }
}

function requireDevelopmentKey(
  setup: IOSLocalSetupResult,
  publishableKey: string | undefined,
): string {
  const planNeedsKey = Boolean(
    setup.directConfigPlan ||
    setup.runtimeKeyPlan ||
    setup.runtimeKeyVerificationPlan ||
    setup.associatedDomainPlan?.requiresPublishableKey,
  );
  if (planNeedsKey !== setup.requiresDevelopmentKey) {
    throw iosSetupError(
      "The approved iOS setup plan is internally inconsistent. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (!planNeedsKey) return "";
  if (!publishableKey) {
    throw iosSetupError(
      "The linked Clerk application's development publishable key was not available. No local setup changes were written.",
      ERROR_CODE.IOS_PUBLISHABLE_KEY_UNAVAILABLE,
    );
  }
  return publishableKey;
}

function assertCoherentLocalSetup(setup: IOSLocalSetupResult): void {
  if (setup.prebuiltAuthRequested && !setup.prebuiltAuthPlan) {
    throw iosSetupError(
      "The approved iOS setup selected prebuilt authentication without a validated source plan. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const expectedPrebuiltAuthActive =
    setup.prebuiltAuthRequested || setup.prebuiltAuthPlan?.status === "satisfied";
  if (setup.prebuiltAuthActive !== expectedPrebuiltAuthActive) {
    throw iosSetupError(
      "The approved iOS setup contains inconsistent prebuilt authentication state. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (setup.prebuiltAuthAppleEntitlementPlan && !setup.prebuiltAuthActive) {
    throw iosSetupError(
      "The approved iOS setup contains an unselected AuthView capability plan. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (
    setup.directConfigPlan?.sourcePath &&
    setup.prebuiltAuthPlan?.status === "ready" &&
    setup.directConfigPlan.sourcePath === setup.prebuiltAuthPlan.sourcePath
  ) {
    throw iosSetupError(
      "The approved iOS setup contains overlapping Swift source mutations. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (
    setup.runtimeKeyPlan &&
    (setup.associatedDomainPlan?.missingEntitlementsSettings ||
      setup.appleEntitlementPlan?.missingEntitlementsSettings)
  ) {
    throw iosSetupError(
      "The approved iOS setup cannot combine a LocalSecrets write with new entitlements-file creation. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const runtimePlans = [
    setup.directConfigPlan,
    setup.runtimeKeyPlan,
    setup.runtimeKeyVerificationPlan,
  ].filter((plan) => plan != null);
  if (runtimePlans.length > 1) {
    throw iosSetupError(
      "The approved iOS setup contains conflicting runtime configuration routes. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const plans: Array<{ root: string; projectPath: string; targetId: string }> = [
    setup.sdkInstallPlan,
    ...runtimePlans,
  ].filter((plan) => plan != null);
  if (setup.prebuiltAuthPlan) plans.push(setup.prebuiltAuthPlan);
  if (setup.associatedDomainPlan) plans.push(setup.associatedDomainPlan);
  if (setup.appleEntitlementPlan) plans.push(setup.appleEntitlementPlan);
  if (setup.prebuiltAuthAppleEntitlementPlan) {
    plans.push(setup.prebuiltAuthAppleEntitlementPlan);
  }
  if (setup.nativeReadiness.target.status !== "selected") {
    throw iosSetupError(
      "The approved iOS setup no longer identifies one selected native target. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  plans.push({
    root: setup.nativeReadiness.root,
    projectPath: setup.nativeReadiness.target.projectPath,
    targetId: setup.nativeReadiness.target.targetId,
  });
  const selection = plans[0];
  if (
    selection &&
    plans.some(
      (plan) =>
        plan.root !== selection.root ||
        plan.projectPath !== selection.projectPath ||
        plan.targetId !== selection.targetId,
    )
  ) {
    throw iosSetupError(
      "The approved iOS setup no longer identifies one consistent Xcode target. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
}

/**
 * Commits a previously previewed iOS setup after authentication. Fresh direct
 * configuration combines project.pbxproj and the Swift entry source in one
 * guarded local transaction. Existing LocalSecrets integrations retain their
 * specialized compatibility transaction.
 */
export async function applyIOSPlannedLocalSetup(
  setup: IOSLocalSetupResult,
  publishableKey?: string,
  options: ApplyIOSPlannedLocalSetupOptions = {},
): Promise<void> {
  assertCoherentLocalSetup(setup);
  if (setup.prebuiltAuthActive) {
    if (setup.nativeReadiness.target.status !== "selected") {
      throw iosSetupError(
        "The approved prebuilt AuthView setup no longer identifies one selected iOS target. No local setup changes were written; rerun clerk init.",
        ERROR_CODE.IOS_SETUP_PLAN_INVALID,
      );
    }
    const inspection = await inspectIOSProject(setup.nativeReadiness.root, {
      target: setup.nativeReadiness.target.targetId,
    });
    const runtimeBlockers = planIOSPrebuiltAuthRuntimeBlockers(
      inspection,
      setup.directConfigPlan,
      setup.runtimeKeyPlan,
    );
    if (runtimeBlockers.length > 0) {
      throw iosSetupError(
        `The approved prebuilt AuthView setup no longer proves its Clerk runtime prerequisites. No local setup changes were written:\n${runtimeBlockers
          .map((message) => `  • ${message}`)
          .join("\n")}`,
        ERROR_CODE.IOS_SETUP_STALE,
      );
    }
  }
  const key = requireDevelopmentKey(setup, publishableKey);

  // Existing LocalSecrets values are verified before any PBX mutation. A
  // mismatched application can therefore never change the selected target.
  if (setup.runtimeKeyVerificationPlan) {
    const result = await withSpinner("Verifying the existing iOS publishable key...", async () =>
      verifyIOSRuntimeKey(setup.runtimeKeyVerificationPlan!, key),
    );
    assertRuntimeKeyVerificationMatched(result);
  }

  const preparedSDK = await prepareSDKForCommit(setup.sdkInstallPlan);
  const preparedPrebuiltAuth = await preparePrebuiltAuthForCommit(setup.prebuiltAuthPlan);

  if (setup.directConfigPlan) {
    const preparedDirect = await prepareIOSDirectConfigMutation(setup.directConfigPlan, key);
    if (preparedDirect.status === "stale") {
      throw iosSetupError(
        "The Swift app entry source changed after the preview. No local setup changes were written; rerun clerk init.",
        ERROR_CODE.IOS_SETUP_STALE,
      );
    }
    if (preparedDirect.status === "blocked") {
      throw iosSetupError(
        `The Swift app entry source could no longer be configured safely. No local setup changes were written:\n${blockerList(preparedDirect.plan.blockers)}`,
      );
    }
    // Verify an existing inline key before using the supplied key to derive
    // its entitlements candidate. A mismatch must retain the dedicated
    // wrong-application error and leave every file untouched.
    const preparedAssociatedDomain = await prepareAssociatedDomainForCommit(
      setup.associatedDomainPlan,
      key || undefined,
      preparedSDK?.status === "ready" ? preparedSDK.mutation : undefined,
    );

    const baseMutations: IOSFileMutation[] = [];
    const postconditions: Array<() => boolean | Promise<boolean>> = [];
    if (options.beforePostWriteValidation) {
      postconditions.push(async () => {
        await options.beforePostWriteValidation?.();
        return true;
      });
    }
    if (
      preparedSDK?.status === "ready" &&
      !(
        preparedAssociatedDomain?.status === "ready" &&
        preparedAssociatedDomain.consumesBasePbxMutation
      )
    ) {
      baseMutations.push(preparedSDK.mutation);
    }
    if (preparedSDK) {
      postconditions.push(async () => validateIOSSDKInstallPostcondition(preparedSDK.plan));
    }
    if (preparedAssociatedDomain?.status === "ready") {
      baseMutations.push(...preparedAssociatedDomain.mutations);
      postconditions.push(async () =>
        validatePreparedIOSAssociatedDomain(preparedAssociatedDomain),
      );
    } else if (preparedAssociatedDomain?.status === "satisfied") {
      postconditions.push(async () =>
        validateSatisfiedAssociatedDomain(preparedAssociatedDomain.plan),
      );
    }
    const preparedAppleEntitlement = await prepareAppleEntitlementForCommit(
      setup.appleEntitlementPlan,
      baseMutations,
    );
    const mutations = composeAppleMutations(baseMutations, preparedAppleEntitlement);
    if (preparedAppleEntitlement?.status === "ready") {
      postconditions.push(async () =>
        validatePreparedIOSAppleEntitlement(preparedAppleEntitlement),
      );
    } else if (preparedAppleEntitlement?.status === "satisfied") {
      postconditions.push(async () =>
        validateSatisfiedAppleEntitlement(preparedAppleEntitlement.plan),
      );
    }
    // Commit the entitlements file and its Xcode settings before Swift starts
    // depending on the configured SDK. A process interruption can then leave
    // only harmless project prerequisites, never source that imports an
    // unlinked package.
    if (preparedDirect.status === "ready") {
      mutations.push(directFileMutation(preparedDirect));
      postconditions.push(async () => validatePreparedIOSDirectConfig(preparedDirect));
    } else {
      postconditions.push(async () => {
        const verified = await prepareIOSDirectConfigMutation(setup.directConfigPlan!, key);
        return verified.status === "satisfied";
      });
    }
    if (preparedPrebuiltAuth?.status === "ready") {
      mutations.push(prebuiltAuthFileMutation(preparedPrebuiltAuth));
      postconditions.push(async () => validatePreparedIOSPrebuiltAuth(preparedPrebuiltAuth));
    } else if (preparedPrebuiltAuth?.status === "satisfied") {
      postconditions.push(async () => validateSatisfiedPrebuiltAuth(preparedPrebuiltAuth.plan));
    }
    if (setup.prebuiltAuthActive) {
      postconditions.push(async () => validatePrebuiltAuthRuntimePostcondition(setup, false));
    }
    assertUniqueMutationPaths(mutations);

    if (mutations.length > 0) {
      const result = await withSpinner("Applying the local iOS setup...", async () =>
        applyIOSFileTransaction(mutations, postconditions),
      );
      if (result.status === "stale") {
        throw iosSetupError(
          "An iOS setup file changed while the approved changes were being committed. Any partial write was restored; rerun clerk init.",
          ERROR_CODE.IOS_SETUP_STALE,
        );
      }
      if (result.status === "rolled-back") {
        throw iosSetupError(
          "The local iOS setup failed post-write validation and was restored byte-for-byte.",
          ERROR_CODE.IOS_LOCAL_APPLY_FAILED,
        );
      }
    }

    if (preparedSDK?.status === "ready") {
      log.success(`${formatProducts(preparedSDK.plan.products)} linked to ${setup.targetName}`);
    }
    if (preparedDirect.status === "ready") {
      log.success(`Clerk configured in ${preparedDirect.plan.sourcePath}`);
    } else {
      log.info(dim("The existing inline publishable key matches the linked Clerk application."));
    }
    if (preparedPrebuiltAuth?.status === "ready") {
      log.success(`Prebuilt AuthView added to ${preparedPrebuiltAuth.plan.sourcePath}`);
    }
    if (!setup.runtimeKeyPlan && preparedAssociatedDomain?.status === "ready") {
      log.success("Clerk Associated Domain added to the selected target entitlements");
    }
    if (preparedAppleEntitlement?.status === "ready") {
      log.success("Sign in with Apple entitlement added to the selected target");
    }
    return;
  }

  const preparedAssociatedDomain = await prepareAssociatedDomainForCommit(
    setup.associatedDomainPlan,
    key || undefined,
    preparedSDK?.status === "ready" ? preparedSDK.mutation : undefined,
  );
  const baseMutations: IOSFileMutation[] = [
    ...(preparedAssociatedDomain?.status === "ready" ? preparedAssociatedDomain.mutations : []),
    ...(preparedSDK?.status === "ready" &&
    !(
      preparedAssociatedDomain?.status === "ready" &&
      preparedAssociatedDomain.consumesBasePbxMutation
    )
      ? [preparedSDK.mutation]
      : []),
    ...(preparedPrebuiltAuth?.status === "ready"
      ? [prebuiltAuthFileMutation(preparedPrebuiltAuth)]
      : []),
  ];
  const preparedAppleEntitlement = await prepareAppleEntitlementForCommit(
    setup.appleEntitlementPlan,
    baseMutations,
  );
  const localMutations = composeAppleMutations(baseMutations, preparedAppleEntitlement);
  assertUniqueMutationPaths(localMutations);

  // SDK-only and LocalSecrets compatibility routes apply the PBX candidate
  // after authentication. If the specialized key transaction subsequently
  // fails, restore the PBX bytes when they are still untouched.
  if (localMutations.length > 0) {
    const postconditions: Array<() => boolean | Promise<boolean>> = [
      ...(preparedSDK ? [async () => validateIOSSDKInstallPostcondition(preparedSDK.plan)] : []),
      ...(preparedAssociatedDomain?.status === "ready"
        ? [async () => validatePreparedIOSAssociatedDomain(preparedAssociatedDomain)]
        : preparedAssociatedDomain?.status === "satisfied"
          ? [async () => validateSatisfiedAssociatedDomain(preparedAssociatedDomain.plan)]
          : []),
      ...(preparedAppleEntitlement?.status === "ready"
        ? [async () => validatePreparedIOSAppleEntitlement(preparedAppleEntitlement)]
        : preparedAppleEntitlement?.status === "satisfied"
          ? [async () => validateSatisfiedAppleEntitlement(preparedAppleEntitlement.plan)]
          : []),
      ...(preparedPrebuiltAuth?.status === "ready"
        ? [async () => validatePreparedIOSPrebuiltAuth(preparedPrebuiltAuth)]
        : preparedPrebuiltAuth?.status === "satisfied"
          ? [async () => validateSatisfiedPrebuiltAuth(preparedPrebuiltAuth.plan)]
          : []),
      ...(setup.prebuiltAuthActive
        ? [
            async () =>
              validatePrebuiltAuthRuntimePostcondition(setup, setup.runtimeKeyPlan != null),
          ]
        : []),
    ];
    if (setup.runtimeKeyVerificationPlan) {
      postconditions.push(async () => {
        await options.beforePostWriteValidation?.();
        return (
          (await verifyIOSRuntimeKey(setup.runtimeKeyVerificationPlan!, key)).status === "matched"
        );
      });
    }
    const result = await withSpinner("Applying the local iOS setup...", async () =>
      applyIOSFileTransaction(localMutations, postconditions),
    );
    if (result.status === "stale") {
      throw iosSetupError(
        "The Xcode project changed after the preview. No SDK change was written; rerun clerk init.",
        ERROR_CODE.IOS_SETUP_STALE,
      );
    }
    if (result.status === "rolled-back") {
      throw iosSetupError(
        "The local iOS setup changed during post-write validation. The Clerk iOS SDK change was restored byte-for-byte; rerun clerk init.",
        ERROR_CODE.IOS_LOCAL_APPLY_FAILED,
      );
    }
    if (!setup.runtimeKeyPlan && preparedSDK?.status === "ready") {
      log.success(`${formatProducts(preparedSDK.plan.products)} linked to ${setup.targetName}`);
    }
    if (!setup.runtimeKeyPlan && preparedAssociatedDomain?.status === "ready") {
      log.success("Clerk Associated Domain added to the selected target entitlements");
    }
    if (!setup.runtimeKeyPlan && preparedAppleEntitlement?.status === "ready") {
      log.success("Sign in with Apple entitlement added to the selected target");
    }
    if (!setup.runtimeKeyPlan && preparedPrebuiltAuth?.status === "ready") {
      log.success(`Prebuilt AuthView added to ${preparedPrebuiltAuth.plan.sourcePath}`);
    }
  }

  if (setup.runtimeKeyPlan) {
    try {
      await applyIOSRuntimeKeySetup(setup.runtimeKeyPlan, key);
    } catch (error) {
      await rollbackPreparedLocalMutations(existingMutationsOnly(localMutations));
      throw error;
    }
    if (preparedSDK?.status === "ready") {
      log.success(`${formatProducts(preparedSDK.plan.products)} linked to ${setup.targetName}`);
    }
    if (preparedAssociatedDomain?.status === "ready") {
      log.success("Clerk Associated Domain added to the selected target entitlements");
    }
    if (preparedAppleEntitlement?.status === "ready") {
      log.success("Sign in with Apple entitlement added to the selected target");
    }
    if (preparedPrebuiltAuth?.status === "ready") {
      log.success(`Prebuilt AuthView added to ${preparedPrebuiltAuth.plan.sourcePath}`);
    }
  } else if (setup.runtimeKeyVerificationPlan) {
    log.info(dim("The existing publishable key matches the linked Clerk application."));
  }
}

export async function applyIOSRuntimeKeySetup(
  plan: IOSRuntimeKeyPlan,
  publishableKey: string,
): Promise<void> {
  const result = await withSpinner("Wiring the development publishable key...", async () =>
    applyIOSRuntimeKey(plan, publishableKey),
  );
  if (result.status === "applied") {
    log.success(`Publishable key wired to ${plan.localSecretsPath}`);
    return;
  }
  if (result.status === "satisfied") {
    log.info(dim(`The linked publishable key is already wired to ${plan.localSecretsPath}.`));
    return;
  }
  if (result.status === "stale") {
    throw iosSetupError(
      "LocalSecrets.plist or .gitignore changed after the preview. Nothing new was written; rerun clerk init to build a fresh plan.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (result.status === "rolled-back") {
    throw iosSetupError(
      result.message ?? "The runtime-key update failed validation and was restored.",
      ERROR_CODE.IOS_LOCAL_APPLY_FAILED,
    );
  }
  const reasons = result.plan.blockers.map((blocker) => `  • ${blocker.message}`).join("\n");
  throw iosSetupError(
    result.message ?? `The development publishable key could not be wired safely:\n${reasons}`,
    ERROR_CODE.IOS_LOCAL_APPLY_FAILED,
  );
}

export async function verifyIOSRuntimeKeySetup(
  plan: IOSRuntimeKeyVerificationPlan,
  linkedPublishableKey: string,
): Promise<void> {
  const result = await withSpinner("Verifying the existing iOS publishable key...", async () =>
    verifyIOSRuntimeKey(plan, linkedPublishableKey),
  );
  assertRuntimeKeyVerificationMatched(result);
  log.info(dim("The existing publishable key matches the linked Clerk application."));
}

function assertRuntimeKeyVerificationMatched(
  result: Awaited<ReturnType<typeof verifyIOSRuntimeKey>>,
): void {
  if (result.status === "matched") return;
  if (result.status === "mismatched") {
    throw iosSetupError(
      "The existing iOS runtime publishable key does not match the linked Clerk application's development key. No key was changed; link the matching application or clear the existing runtime key intentionally before rerunning clerk init.",
      ERROR_CODE.IOS_PUBLISHABLE_KEY_MISMATCH,
    );
  }
  if (result.status === "stale") {
    throw iosSetupError(
      "LocalSecrets.plist changed after the read-only verification preflight. No key was changed; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  const reasons = result.plan.blockers.map((blocker) => `  • ${blocker.message}`).join("\n");
  throw iosSetupError(
    `The existing iOS runtime publishable key could not be verified safely. No key was changed:\n${reasons}`,
  );
}
