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
import { hasIncompleteIOSContainerDiscovery, inspectIOSProject } from "./inspect.ts";
import {
  prepareIOSSDKInstallMutation,
  validateIOSSDKInstallPostcondition,
  type IOSSDKInstallPlan,
  type PreparedIOSSDKInstallMutation,
} from "./install-sdk.ts";
import { buildIOSSetupPlan } from "./plan.ts";
import {
  prepareIOSDirectConfigMutation,
  validatePreparedIOSDirectConfig,
  type IOSDirectConfigPlan,
  type IOSDirectConfigPreparedMutation,
} from "./direct-config.ts";
import {
  applyIOSFileTransaction,
  type IOSExistingFileMutation,
  type IOSFileMutation,
} from "./file-transaction.ts";
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
  planMacOSNetworkCapability,
  prepareMacOSNetworkCapabilityMutation,
  validatePreparedMacOSNetworkCapability,
  type MacOSNetworkCapabilityPlan,
  type PreparedMacOSNetworkCapabilityMutation,
} from "./macos-network.ts";
import {
  planIOSPrebuiltAuth,
  prepareIOSPrebuiltAuthMutation,
  validatePreparedIOSPrebuiltAuth,
  type IOSPrebuiltAuthPlan,
  type PreparedIOSPrebuiltAuthMutation,
} from "./prebuilt-auth.ts";
import {
  buildIOSLocalSetupProposal,
  createIOSLocalSetupContext,
  planIOSPrebuiltAuthRuntimeBlockers,
  type IOSLocalSetupProposal,
} from "./local-plan.ts";

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

export type IOSLocalSetupResult = Pick<
  IOSLocalSetupProposal,
  | "setupPlan"
  | "nativeReadiness"
  | "unverifiedAppIdPrefixSuggestion"
  | "sdkInstallPlan"
  | "directConfigPlan"
  | "associatedDomainPlan"
  | "macOSNetworkCapabilityPlan"
  | "appleEntitlementPlan"
  | "prebuiltAuthPlan"
  | "prebuiltAuthAppleEntitlementPlan"
  | "prebuiltAuthRequested"
  | "prebuiltAuthActive"
  | "nativeAppleRequested"
  | "platform"
> & {
  targetName: string;
  /** Authentication must return an exact app ID and development key before commit. */
  requiresLinkedApp: boolean;
  /** The approved local transaction consumes the linked development publishable key. */
  requiresDevelopmentKey: boolean;
  /** A preserved runtime configuration requires the developer to choose its Clerk application. */
  requiresExplicitApplication: boolean;
};

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

async function validatePrebuiltAuthRuntimePostcondition(
  setup: IOSLocalSetupResult,
): Promise<boolean> {
  if (!setup.prebuiltAuthActive) return true;
  if (setup.nativeReadiness.target.status !== "selected") return false;
  const target = setup.nativeReadiness.target;
  const inspection = await inspectIOSProject(setup.nativeReadiness.root, {
    target: target.targetId,
    exhaustiveContainerDiscovery: true,
  });
  if (
    hasIncompleteIOSContainerDiscovery(inspection) ||
    inspection.selection.state !== "selected" ||
    inspection.selection.targetId !== target.targetId ||
    inspection.selection.projectPath !== target.projectPath
  ) {
    return false;
  }
  const setupPlan = buildIOSSetupPlan(inspection);
  const configureStep = setupPlan.steps.find((step) => step.id === "configure-publishable-key");
  const environmentStep = setupPlan.steps.find((step) => step.id === "inject-clerk-environment");
  return configureStep?.status === "satisfied" && environmentStep?.status === "satisfied";
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
    inspectIOSProject(options.root, {
      target: options.target,
      exhaustiveContainerDiscovery: true,
    }),
  );
  const context = createIOSLocalSetupContext(inspection);
  if (hasIncompleteIOSContainerDiscovery(inspection)) {
    throw iosSetupError(
      "Xcode project discovery was incomplete, so Clerk cannot safely select a native Apple application target. Run the command from the intended project's directory, make nested project directories readable, or reduce excessive project nesting or count.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
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
        `More than one native Apple application target is eligible: ${candidates}. Rerun with --target <name-or-id>; if IDs collide across copied projects, run the command from the intended project's directory.`,
      );
    }
    if (selection.state === "not-found") {
      throwUsageError(
        `The native Apple target "${selection.requested}" was not found. Available targets: ${
          selection.candidates.join(", ") || "none"
        }.`,
      );
    }
    throw iosSetupError(
      "No usable iOS or macOS application target was found.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }

  const selectedTarget = context.selectedTarget;
  if (!selectedTarget) {
    throw iosSetupError(
      "The selected native Apple target could not be resolved safely.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
  const productDecision = context.productDecision;
  if (!productDecision) {
    throw iosSetupError(
      "The selected native Apple target could not be planned safely.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
  if (!selectedTarget.platformEvidenceComplete) {
    throw iosSetupError(
      "The selected target's iOS or macOS platform could not be proven consistently across every build configuration. No local or remote changes were made; resolve SDKROOT and SUPPORTED_PLATFORMS, then rerun clerk init.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
  const platformLabel = selectedTarget.platform === "macos" ? "macOS" : "iOS";
  if (productDecision === "unknown") {
    throw iosSetupError(
      "The selected target's Swift source membership could not be inspected completely, so Clerk cannot safely choose between the prebuilt ClerkKitUI path and a core-only custom flow. Resolve the Xcode source-membership diagnostics, then rerun clerk init.",
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }

  const proposal = await buildIOSLocalSetupProposal(context, {
    root: options.root,
    allowDirty: options.allowDirty,
    prebuiltAuthUI: options.prebuiltAuthUI,
    signInWithApple: options.signInWithApple,
    ...(!options.agent && !options.yes
      ? {
          resolvePrebuiltAuthRequest: async ({ targetName }: { targetName: string }) =>
            confirm({
              message: `Add ClerkKitUI's prebuilt authentication UI to ${targetName}?`,
              default: false,
            }),
          resolveNativeAppleRequest: async ({ bundleIdentifier }: { bundleIdentifier: string }) =>
            confirm({
              message: `Enable native Sign in with Apple for ${bundleIdentifier}?`,
              default: false,
            }),
        }
      : {}),
  });
  const {
    inspectedPrebuiltAuthPlan,
    prebuiltAuthPlan,
    prebuiltAuthRequested,
    prebuiltAuthActive,
    installPlan,
    reviewOnlyUnattributedInstall,
    directConfigPlan,
    plannedAssociatedDomain,
    associatedDomainPlan,
    macOSNetworkCapabilityPlan,
    appleEntitlementPlan,
    prebuiltAuthAppleEntitlementPlan,
    nativeAppleRequested,
    nativeReadiness,
    hasCustomConfigure,
    hasSupportedCustomConfigure,
    prebuiltRuntimeBlockers,
  } = proposal;
  if (
    !installPlan ||
    !inspectedPrebuiltAuthPlan ||
    (selectedTarget.platform === "ios" && !plannedAssociatedDomain)
  ) {
    throw iosSetupError(
      `The selected ${platformLabel} target did not produce one complete local setup proposal.`,
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (prebuiltAuthRequested && inspectedPrebuiltAuthPlan.status === "blocked") {
    throw iosSetupError(
      `The prebuilt AuthView flow could not be added safely. No local files were changed:\n${blockerList(
        inspectedPrebuiltAuthPlan.blockers,
      )}`,
    );
  }
  if (
    directConfigNeedsWrite(directConfigPlan) &&
    prebuiltAuthPlan?.status === "ready" &&
    directConfigPlan?.sourcePath === prebuiltAuthPlan.sourcePath
  ) {
    throw iosSetupError(
      `The approved ${platformLabel} setup resolved the Clerk initializer and prebuilt AuthView scaffold to the same Swift source unexpectedly. No local files were changed; review the app root and rerun clerk init.`,
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (macOSNetworkCapabilityPlan?.status === "blocked") {
    throw iosSetupError(
      `Outgoing network access could not be configured safely for the selected macOS target. No local files were changed:\n${blockerList(
        macOSNetworkCapabilityPlan.blockers,
      )}`,
    );
  }
  if (
    nativeReadiness.target.status !== "selected" ||
    nativeReadiness.target.bundleIdentifier.status !== "resolved"
  ) {
    throw iosSetupError(
      `The selected ${platformLabel} target does not have one proven Bundle ID across all build configurations. No local files were changed; resolve PRODUCT_BUNDLE_IDENTIFIER, then rerun clerk init.`,
      ERROR_CODE.IOS_TARGET_UNRESOLVED,
    );
  }
  if (appleEntitlementPlan?.status === "blocked") {
    throw iosSetupError(
      `Native Sign in with Apple could not be configured safely. No local files were changed:\n${blockerList(
        appleEntitlementPlan.blockers,
      )}`,
    );
  }
  if (directConfigPlan?.status === "blocked") {
    throw iosSetupError(
      `The selected SwiftUI app could not be configured automatically. No local files were changed:\n${blockerList(
        directConfigPlan.blockers,
      )}`,
    );
  }
  if (
    (productDecision === "prebuilt" || prebuiltAuthActive) &&
    selectedTarget.swift.configureCalls.length === 0 &&
    !directConfigPlan
  ) {
    throw iosSetupError(
      "The fresh SwiftUI target was not edited because the selected runtime configuration could not be proven. Configure Clerk directly in the @main initializer, then rerun clerk init. No local files were changed.",
    );
  }
  if (hasCustomConfigure && !hasSupportedCustomConfigure) {
    throw iosSetupError(
      "A custom Clerk.configure(...) source was found, but it is not one unambiguous call in the selected app's startup initializer. clerk init preserved it and made no local or remote changes. Confirm the shipping configuration manually, then rerun the command.",
    );
  }
  if (prebuiltAuthActive) {
    if (prebuiltRuntimeBlockers.length > 0) {
      throw iosSetupError(
        `The prebuilt AuthView flow requires a proven Clerk runtime and SwiftUI environment before its source can be added. No local files were changed:\n${prebuiltRuntimeBlockers
          .map((message) => `  • ${message}`)
          .join("\n")}`,
      );
    }
  }

  if (installPlan.status === "satisfied") {
    const verb = installPlan.products.length === 1 ? "is" : "are";
    log.info(
      dim(
        `\n${formatProducts(installPlan.products)} ${verb} already linked to ${
          selection.targetName
        }.`,
      ),
    );
  }
  if (reviewOnlyUnattributedInstall) {
    const verb = installPlan.products.length === 1 ? "is" : "are";
    log.info(
      dim(
        `\n${formatProducts(installPlan.products)} ${verb} already linked to ${
          selection.targetName
        }, but package attribution is not represented in this project graph. The existing Xcode package graph will be left unchanged.`,
      ),
    );
  } else if (installPlan.status === "blocked") {
    throw iosSetupError(
      `The Clerk ${selectedTarget.platform === "macos" ? "Swift" : "iOS"} SDK could not be installed automatically:\n${blockerList(
        installPlan.blockers,
      )}`,
    );
  }
  const plannedPaths: Array<{ absolutePath: string; displayPath: string }> = [];
  if (installPlan.status === "ready") {
    plannedPaths.push({
      absolutePath: resolve(options.root, selection.projectPath, "project.pbxproj"),
      displayPath: `${selection.projectPath}/project.pbxproj`,
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
  if (macOSNetworkCapabilityPlan?.status === "ready") {
    if (macOSNetworkCapabilityPlan.missingEntitlementsSettings) {
      plannedPaths.push({
        absolutePath: resolve(options.root, selection.projectPath, "project.pbxproj"),
        displayPath: `${selection.projectPath}/project.pbxproj`,
      });
    }
    for (const file of macOSNetworkCapabilityPlan.files) {
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
    directConfigNeedsWrite(directConfigPlan) ||
    prebuiltAuthPlan?.status === "ready" ||
    associatedDomainNeedsWrite(associatedDomainPlan) ||
    macOSNetworkCapabilityPlan?.status === "ready" ||
    appleEntitlementPlan?.status === "ready" ||
    prebuiltAuthAppleEntitlementPlan?.status === "ready";
  if (hasLocalWrites) {
    log.info(`\nclerk init will make the following local ${platformLabel} changes:\n`);
  } else if (
    directConfigPlan ||
    macOSNetworkCapabilityPlan ||
    appleEntitlementPlan ||
    prebuiltAuthPlan
  ) {
    log.info(`\nclerk init will perform the following read-only ${platformLabel} verification:\n`);
  }
  if (installPlan.status === "ready") {
    log.info(`  ${yellow("MODIFY")}  ${selection.projectPath}/project.pbxproj`);
    for (const action of installPlan.actions) log.info(`          ${action}`);
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
  if (hasSupportedCustomConfigure) {
    log.info(
      dim(
        "  PRESERVE  Custom Clerk.configure(...) publishable-key source. Its value will not be inspected; the developer must select the existing Clerk application it belongs to.",
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
  if (macOSNetworkCapabilityPlan?.status === "ready") {
    if (
      macOSNetworkCapabilityPlan.missingEntitlementsSettings &&
      installPlan.status !== "ready" &&
      !associatedDomainPlan?.missingEntitlementsSettings
    ) {
      log.info(`  ${yellow("MODIFY")}  ${selection.projectPath}/project.pbxproj`);
    }
    for (const file of macOSNetworkCapabilityPlan.files) {
      log.info(`  ${yellow(file.operation === "create" ? "CREATE" : "MODIFY")}  ${file.path}`);
    }
    for (const action of macOSNetworkCapabilityPlan.actions) log.info(`          ${action}`);
  } else if (macOSNetworkCapabilityPlan?.status === "satisfied") {
    log.info(dim("\n  Outgoing network access is already available to the selected macOS target."));
  }
  if (appleEntitlementPlan?.status === "ready") {
    const alreadyPreviewedEntitlements = new Set([
      ...(associatedDomainNeedsWrite(associatedDomainPlan)
        ? associatedDomainPlan.files.map((file) => file.path)
        : []),
      ...(macOSNetworkCapabilityPlan?.status === "ready"
        ? macOSNetworkCapabilityPlan.files.map((file) => file.path)
        : []),
    ]);
    if (
      appleEntitlementPlan.missingEntitlementsSettings &&
      installPlan.status !== "ready" &&
      !associatedDomainPlan?.missingEntitlementsSettings &&
      !macOSNetworkCapabilityPlan?.missingEntitlementsSettings
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
    if (macOSNetworkCapabilityPlan?.status === "ready") {
      if (macOSNetworkCapabilityPlan.missingEntitlementsSettings) {
        alreadyPreviewedPaths.add(`${selection.projectPath}/project.pbxproj`);
      }
      for (const file of macOSNetworkCapabilityPlan.files) {
        alreadyPreviewedPaths.add(file.path);
      }
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
        ? `\n  After authentication, clerk init will inspect Native API, ${platformLabel} registration, and the native Apple connection before separately previewing additive remote changes.`
        : `\n  After authentication, clerk init will inspect Native API and ${platformLabel} registration state and separately preview any additive remote changes.`,
    ),
  );
  log.blank();

  if (hasLocalWrites && options.agent && !options.yes) {
    throwUsageError(
      "Changing an Xcode project in agent mode requires explicit consent. Review `clerk init --dry-run`, then rerun `clerk init --yes`.",
    );
  }
  if (hasLocalWrites && !options.yes) {
    const proceed = await confirm({
      message: `Apply these local ${platformLabel} changes?`,
      default: false,
    });
    if (!proceed) throwUserAbort();
  }

  return {
    ...proposal,
    targetName: selection.targetName,
    requiresLinkedApp: true,
    requiresDevelopmentKey:
      directConfigPlan != null || associatedDomainPlan?.requiresPublishableKey === true,
    requiresExplicitApplication:
      hasSupportedCustomConfigure || directConfigPlan?.changes?.configuration === "verify-existing",
  };
}

function directFileMutation(
  prepared: Extract<IOSDirectConfigPreparedMutation, { status: "ready" }>,
): IOSExistingFileMutation {
  return {
    path: prepared.mutation.absolutePath,
    boundary: prepared.mutation.boundary,
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
    boundary: prepared.mutation.boundary,
    originalBytes: prepared.mutation.originalBytes,
    originalHash: prepared.mutation.expectedHash,
    candidateBytes: prepared.mutation.candidateBytes,
    candidateHash: prepared.mutation.candidateHash,
    mode: prepared.mutation.mode,
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
      `The Clerk ${prepared.plan.platform === "macos" ? "Swift" : "iOS"} SDK could no longer be prepared safely. No local setup changes were written:\n${preparedSDKBlockers(
        prepared,
      )}`,
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
      `The prebuilt AuthView flow could no longer be prepared safely. No local setup changes were written:\n${blockerList(
        prepared.plan.blockers,
      )}`,
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
      `The Clerk Associated Domain could no longer be prepared safely. No local setup changes were written${
        reasons ? `:\n${reasons}` : "."
      }`,
    );
  }
  return prepared;
}

async function prepareAppleEntitlementForCommit(
  plan: IOSAppleEntitlementPlan | undefined,
  baseMutations: readonly IOSFileMutation[],
): Promise<PreparedIOSAppleEntitlementMutation | undefined> {
  if (!plan) return undefined;
  const prepared = await prepareIOSAppleEntitlementMutation(plan, {
    baseMutations,
  });
  if (prepared.status === "stale") {
    throw iosSetupError(
      "A native Apple entitlements file changed after the Sign in with Apple preview. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (prepared.status === "blocked") {
    throw iosSetupError(
      `The Sign in with Apple entitlement could no longer be prepared safely. No local setup changes were written:\n${blockerList(
        prepared.plan.blockers,
      )}`,
    );
  }
  return prepared;
}

async function prepareMacOSNetworkForCommit(
  plan: MacOSNetworkCapabilityPlan | undefined,
  baseMutations: readonly IOSFileMutation[],
): Promise<PreparedMacOSNetworkCapabilityMutation | undefined> {
  if (!plan) return undefined;
  const prepared = await prepareMacOSNetworkCapabilityMutation(plan, { baseMutations });
  if (prepared.status === "stale") {
    throw iosSetupError(
      "The macOS sandbox or entitlements configuration changed after the preview. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_STALE,
    );
  }
  if (prepared.status === "blocked") {
    throw iosSetupError(
      `Outgoing network access could no longer be prepared safely. No local setup changes were written:\n${blockerList(
        prepared.plan.blockers,
      )}`,
    );
  }
  return prepared;
}

function composeMacOSNetworkMutations(
  baseMutations: readonly IOSFileMutation[],
  prepared: PreparedMacOSNetworkCapabilityMutation | undefined,
): IOSFileMutation[] {
  if (prepared?.status !== "ready") return [...baseMutations];
  const consumed = new Set(prepared.consumedBaseMutationPaths);
  return [
    ...baseMutations.filter((mutation) => !consumed.has(resolve(mutation.path))),
    ...prepared.mutations,
  ];
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

function assertUniqueMutationPaths(mutations: readonly IOSFileMutation[]): void {
  const paths = mutations.map((mutation) => resolve(mutation.path));
  if (new Set(paths).size !== paths.length) {
    throw iosSetupError(
      "The approved native Apple setup produced overlapping file mutations. No local setup changes were written; rerun clerk init.",
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
    platform: plan.platform,
  });
  return current.status === "satisfied";
}

async function validateSatisfiedMacOSNetwork(plan: MacOSNetworkCapabilityPlan): Promise<boolean> {
  const current = await planMacOSNetworkCapability({
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

function requireDevelopmentKey(
  setup: IOSLocalSetupResult,
  publishableKey: string | undefined,
): string {
  const planNeedsKey = Boolean(
    setup.directConfigPlan || setup.associatedDomainPlan?.requiresPublishableKey,
  );
  if (planNeedsKey !== setup.requiresDevelopmentKey) {
    throw iosSetupError(
      "The approved native Apple setup plan is internally inconsistent. No local setup changes were written; rerun clerk init.",
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
      "The approved native Apple setup selected prebuilt authentication without a validated source plan. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const expectedPrebuiltAuthActive =
    setup.prebuiltAuthRequested || setup.prebuiltAuthPlan?.status === "satisfied";
  if (setup.prebuiltAuthActive !== expectedPrebuiltAuthActive) {
    throw iosSetupError(
      "The approved native Apple setup contains inconsistent prebuilt authentication state. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (setup.prebuiltAuthAppleEntitlementPlan && !setup.prebuiltAuthActive) {
    throw iosSetupError(
      "The approved native Apple setup contains an unselected AuthView capability plan. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (
    setup.directConfigPlan?.sourcePath &&
    setup.prebuiltAuthPlan?.status === "ready" &&
    setup.directConfigPlan.sourcePath === setup.prebuiltAuthPlan.sourcePath
  ) {
    throw iosSetupError(
      "The approved native Apple setup contains overlapping Swift source mutations. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  const runtimePlans = [setup.directConfigPlan].filter((plan) => plan != null);
  const plans: Array<{ root: string; projectPath: string; targetId: string }> = [
    setup.sdkInstallPlan,
    ...runtimePlans,
  ].filter((plan) => plan != null);
  if (setup.prebuiltAuthPlan) plans.push(setup.prebuiltAuthPlan);
  if (setup.associatedDomainPlan) plans.push(setup.associatedDomainPlan);
  if (setup.macOSNetworkCapabilityPlan) plans.push(setup.macOSNetworkCapabilityPlan);
  if (setup.appleEntitlementPlan) plans.push(setup.appleEntitlementPlan);
  if (setup.prebuiltAuthAppleEntitlementPlan) {
    plans.push(setup.prebuiltAuthAppleEntitlementPlan);
  }
  if (setup.nativeReadiness.target.status !== "selected") {
    throw iosSetupError(
      "The approved native Apple setup no longer identifies one selected target. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if (setup.nativeReadiness.target.platform !== setup.platform) {
    throw iosSetupError(
      "The approved native Apple setup no longer identifies one consistent platform. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
  if ((setup.platform === "macos") !== (setup.macOSNetworkCapabilityPlan != null)) {
    throw iosSetupError(
      "The approved native Apple setup contains inconsistent macOS network-capability state. No local setup changes were written; rerun clerk init.",
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
      "The approved native Apple setup no longer identifies one consistent Xcode target. No local setup changes were written; rerun clerk init.",
      ERROR_CODE.IOS_SETUP_PLAN_INVALID,
    );
  }
}

/**
 * Commits a previously previewed iOS setup after authentication. Fresh direct
 * configuration combines project.pbxproj and the Swift entry source in one
 * guarded local transaction. Existing custom key sources are preserved and
 * are never rewritten or interpreted.
 */
export async function applyIOSPlannedLocalSetup(
  setup: IOSLocalSetupResult,
  publishableKey?: string,
  options: ApplyIOSPlannedLocalSetupOptions = {},
): Promise<void> {
  assertCoherentLocalSetup(setup);
  const platformLabel = setup.platform === "macos" ? "macOS" : "iOS";
  if (setup.prebuiltAuthActive) {
    if (setup.nativeReadiness.target.status !== "selected") {
      throw iosSetupError(
        "The approved prebuilt AuthView setup no longer identifies one selected native Apple target. No local setup changes were written; rerun clerk init.",
        ERROR_CODE.IOS_SETUP_PLAN_INVALID,
      );
    }
    const inspection = await inspectIOSProject(setup.nativeReadiness.root, {
      target: setup.nativeReadiness.target.targetId,
      exhaustiveContainerDiscovery: true,
    });
    if (
      hasIncompleteIOSContainerDiscovery(inspection) ||
      inspection.selection.state !== "selected" ||
      inspection.selection.targetId !== setup.nativeReadiness.target.targetId ||
      inspection.selection.projectPath !== setup.nativeReadiness.target.projectPath ||
      inspection.selection.platform !== setup.platform
    ) {
      throw iosSetupError(
        "The approved prebuilt AuthView setup no longer identifies the same exhaustively discovered Xcode target. No local setup changes were written; rerun clerk init.",
        ERROR_CODE.IOS_SETUP_STALE,
      );
    }
    const runtimeBlockers = planIOSPrebuiltAuthRuntimeBlockers(inspection, setup.directConfigPlan);
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
        `The Swift app entry source could no longer be configured safely. No local setup changes were written:\n${blockerList(
          preparedDirect.plan.blockers,
        )}`,
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
    const preparedMacOSNetwork = await prepareMacOSNetworkForCommit(
      setup.macOSNetworkCapabilityPlan,
      baseMutations,
    );
    const networkMutations = composeMacOSNetworkMutations(baseMutations, preparedMacOSNetwork);
    if (preparedMacOSNetwork?.status === "ready") {
      postconditions.push(async () => validatePreparedMacOSNetworkCapability(preparedMacOSNetwork));
    } else if (preparedMacOSNetwork?.status === "satisfied") {
      postconditions.push(async () => validateSatisfiedMacOSNetwork(preparedMacOSNetwork.plan));
    }
    const preparedAppleEntitlement = await prepareAppleEntitlementForCommit(
      setup.appleEntitlementPlan,
      networkMutations,
    );
    const mutations = composeAppleMutations(networkMutations, preparedAppleEntitlement);
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
      postconditions.push(async () => validatePrebuiltAuthRuntimePostcondition(setup));
    }
    assertUniqueMutationPaths(mutations);

    if (mutations.length > 0) {
      const result = await withSpinner(`Applying the local ${platformLabel} setup...`, async () =>
        applyIOSFileTransaction(mutations, postconditions),
      );
      if (result.status === "stale") {
        throw iosSetupError(
          "A native Apple setup file changed while the approved changes were being committed. Any partial write was restored; rerun clerk init.",
          ERROR_CODE.IOS_SETUP_STALE,
        );
      }
      if (result.status === "rolled-back") {
        throw iosSetupError(
          "The local native Apple setup failed post-write validation and was restored byte-for-byte.",
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
    if (preparedAssociatedDomain?.status === "ready") {
      log.success("Clerk Associated Domain added to the selected target entitlements");
    }
    if (preparedMacOSNetwork?.status === "ready") {
      log.success("Outgoing network access enabled for the selected macOS target");
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
  const preparedMacOSNetwork = await prepareMacOSNetworkForCommit(
    setup.macOSNetworkCapabilityPlan,
    baseMutations,
  );
  const networkMutations = composeMacOSNetworkMutations(baseMutations, preparedMacOSNetwork);
  const preparedAppleEntitlement = await prepareAppleEntitlementForCommit(
    setup.appleEntitlementPlan,
    networkMutations,
  );
  const localMutations = composeAppleMutations(networkMutations, preparedAppleEntitlement);
  assertUniqueMutationPaths(localMutations);

  // SDK-only and custom-runtime routes apply their local candidates together
  // after the developer has selected the intended Clerk application.
  if (localMutations.length > 0) {
    const postconditions: Array<() => boolean | Promise<boolean>> = [
      ...(preparedSDK ? [async () => validateIOSSDKInstallPostcondition(preparedSDK.plan)] : []),
      ...(preparedAssociatedDomain?.status === "ready"
        ? [async () => validatePreparedIOSAssociatedDomain(preparedAssociatedDomain)]
        : preparedAssociatedDomain?.status === "satisfied"
          ? [async () => validateSatisfiedAssociatedDomain(preparedAssociatedDomain.plan)]
          : []),
      ...(preparedMacOSNetwork?.status === "ready"
        ? [async () => validatePreparedMacOSNetworkCapability(preparedMacOSNetwork)]
        : preparedMacOSNetwork?.status === "satisfied"
          ? [async () => validateSatisfiedMacOSNetwork(preparedMacOSNetwork.plan)]
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
        ? [async () => validatePrebuiltAuthRuntimePostcondition(setup)]
        : []),
    ];
    if (options.beforePostWriteValidation) {
      postconditions.push(async () => {
        await options.beforePostWriteValidation?.();
        return true;
      });
    }
    const result = await withSpinner(`Applying the local ${platformLabel} setup...`, async () =>
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
        "The local native Apple setup changed during post-write validation. The Clerk SDK change was restored byte-for-byte; rerun clerk init.",
        ERROR_CODE.IOS_LOCAL_APPLY_FAILED,
      );
    }
    if (preparedSDK?.status === "ready") {
      log.success(`${formatProducts(preparedSDK.plan.products)} linked to ${setup.targetName}`);
    }
    if (preparedAssociatedDomain?.status === "ready") {
      log.success("Clerk Associated Domain added to the selected target entitlements");
    }
    if (preparedMacOSNetwork?.status === "ready") {
      log.success("Outgoing network access enabled for the selected macOS target");
    }
    if (preparedAppleEntitlement?.status === "ready") {
      log.success("Sign in with Apple entitlement added to the selected target");
    }
    if (preparedPrebuiltAuth?.status === "ready") {
      log.success(`Prebuilt AuthView added to ${preparedPrebuiltAuth.plan.sourcePath}`);
    }
  }

  if (localMutations.length === 0) await options.beforePostWriteValidation?.();
}
