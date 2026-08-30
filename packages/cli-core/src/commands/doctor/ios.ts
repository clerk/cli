import { decodePublishableKey, fetchUserSettings } from "../../lib/fapi.ts";
import { CliError, ERROR_CODE, FapiError, isAuthError, PlapiError } from "../../lib/errors.ts";
import {
  fetchApplication,
  getNativeSettings,
  listIOSApplications,
  type Application,
  type IOSApplication,
  type NativeSettings,
} from "../../lib/plapi.ts";
import { planIOSAppleEntitlement } from "../init/ios/apple-entitlement.ts";
import { associatedDomainMatches } from "../init/ios/associated-domain.ts";
import { auditIOSPrebuiltAuthEnvironment } from "../init/ios/prebuilt-auth-environment.ts";
import { inspectIOSProject } from "../init/ios/inspect.ts";
import { auditIOSNativeAppleHealth } from "../init/ios/native-apple.ts";
import { buildIOSNativeReadinessAudit } from "../init/ios/native-readiness.ts";
import { auditIOSNativeRemoteSetup } from "../init/ios/native-remote.ts";
import { planIOSSDKInstall, type IOSSDKInstallPlan } from "../init/ios/install-sdk.ts";
import {
  planMacOSNetworkCapability,
  type MacOSNetworkCapabilityPlan,
} from "../init/ios/macos-network.ts";
import { buildIOSSetupPlan } from "../init/ios/plan.ts";
import {
  inspectIOSPlatformViews,
  type IOSPlatformViewsSnapshot,
} from "../init/ios/platform-views.ts";
import { hasSupportedIOSCustomConfigure } from "../init/ios/products.ts";
import type {
  IOSAppTarget,
  IOSNativePlatform,
  IOSProjectInspectionResult,
  IOSSetupStep,
} from "../init/ios/types.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

const LOCAL_STEP_REMEDY = "Run `clerk init --target <target>` to safely complete this step.";
const AUTH_FLOW_REMEDY =
  "Integrate authentication at the app's intended signed-out entry point without replacing existing application UI: present ClerkKitUI's `AuthView`, or build a custom ClerkKit sign-in/sign-up flow.";
const REMOTE_REMEDY =
  "Run `clerk init --target <target>` to preview and apply the missing Native Application setup.";
const IOS_ASSOCIATED_DOMAIN_RESULT_NAME = "iOS: Add Clerk's associated domain";

function platformLabel(platform: IOSNativePlatform): "iOS" | "macOS" {
  return platform === "macos" ? "macOS" : "iOS";
}

function doctorStepTitle(step: IOSSetupStep, platform: IOSNativePlatform): string {
  if (platform === "ios") return step.title;
  if (step.id === "enable-macos-network") return "Allow outgoing network access";
  return step.title
    .replace("iOS application target", "macOS application target")
    .replace("Clerk's iOS SDK", "Clerk's Swift SDK")
    .replace("the iOS app", "the macOS app");
}

export interface IOSDoctorOptions {
  root: string;
  target?: string;
  /** A same-run semantic inspection prepared by Doctor's framework router. */
  preparedInspection?: IOSProjectInspectionResult;
}

export interface IOSDoctorDependencies {
  inspectIOSProject: typeof inspectIOSProject;
  fetchApplication: (
    applicationId: string,
    options: { includeSecretKeys: false },
  ) => Promise<Application>;
  getNativeSettings(applicationId: string, instanceId: string): Promise<NativeSettings>;
  listIOSApplications(applicationId: string, instanceId: string): Promise<IOSApplication[]>;
  fetchUserSettings: typeof fetchUserSettings;
  auditIOSPrebuiltAuthEnvironment: typeof auditIOSPrebuiltAuthEnvironment;
  planIOSAppleEntitlement: typeof planIOSAppleEntitlement;
  auditIOSNativeAppleHealth: typeof auditIOSNativeAppleHealth;
  planIOSSDKInstall: typeof planIOSSDKInstall;
  planMacOSNetworkCapability: typeof planMacOSNetworkCapability;
}

const defaultDependencies: IOSDoctorDependencies = {
  inspectIOSProject,
  fetchApplication,
  getNativeSettings,
  listIOSApplications,
  fetchUserSettings,
  auditIOSPrebuiltAuthEnvironment,
  planIOSAppleEntitlement,
  auditIOSNativeAppleHealth,
  planIOSSDKInstall,
  planMacOSNetworkCapability,
};

function selectedTarget(inspection: IOSProjectInspectionResult): IOSAppTarget | undefined {
  const selection = inspection.selection;
  if (selection.state !== "selected") return undefined;
  return inspection.appTargets.find(
    (target) => target.id === selection.targetId && target.projectPath === selection.projectPath,
  );
}

async function authViewEnvironmentResult(
  target: IOSAppTarget,
  dependencies: IOSDoctorDependencies,
  options: {
    root: string;
    configureStatus: IOSSetupStep["status"] | undefined;
    fapiHost?: string;
    customSource: boolean;
    linked: boolean;
  },
): Promise<CheckResult | undefined> {
  if (target.swift.authViewReferences.length === 0) return undefined;

  const name = `${platformLabel(target.platform)}: AuthView authentication methods`;
  if (options.configureStatus !== "satisfied" || !options.fapiHost) {
    const customUnlinked = options.customSource && !options.linked;
    return {
      name,
      status: "warn",
      message: customUnlinked
        ? "AuthView methods: remote state not inspected (custom key source has no linked application)"
        : "AuthView methods: remote state not inspected (runtime environment was not proven)",
      remedy: customUnlinked
        ? "Run `clerk link --app <app_id>` for the intended Clerk application, then rerun `clerk doctor`."
        : LOCAL_STEP_REMEDY,
    };
  }

  try {
    const environment = dependencies.auditIOSPrebuiltAuthEnvironment(
      await dependencies.fetchUserSettings(options.fapiHost, {}),
    );
    const linkedApplicationSuffix = options.customSource ? " in the linked application" : "";
    if (environment.apple === "blocked") {
      return {
        name,
        status: "fail",
        message: `AuthView methods: Clerk returned an unsupported Apple provider state${linkedApplicationSuffix}`,
        remedy: "Review the Apple connection in Clerk Dashboard, then rerun `clerk doctor`.",
      };
    }
    if (environment.apple === "not-required") {
      return {
        name,
        status: "pass",
        message: `AuthView methods: native Apple sign-in is not currently offered${linkedApplicationSuffix}`,
      };
    }

    const entitlementIsComplete =
      (
        await dependencies.planIOSAppleEntitlement({
          root: options.root,
          projectPath: target.projectPath,
          targetId: target.id,
          platform: target.platform,
          supportedPlatforms: target.supportedPlatforms,
        })
      ).status === "satisfied";
    return entitlementIsComplete
      ? {
          name,
          status: "pass",
          message: `AuthView methods: Apple is enabled${linkedApplicationSuffix} and the local entitlement is present`,
        }
      : {
          name,
          status: "fail",
          message: "AuthView offers Apple sign-in but the selected target lacks its entitlement",
          remedy:
            "Run `clerk init --target <target> --sign-in-with-apple` to preview and safely add the required capability.",
        };
  } catch (error) {
    const serviceUnavailable =
      error instanceof TypeError || (error instanceof FapiError && error.status >= 500);
    if (serviceUnavailable) {
      return {
        name,
        status: "warn",
        message: "AuthView methods: Frontend API state could not be inspected",
        remedy: "Check your network connection, then rerun `clerk doctor`.",
      };
    }
    const malformed = error instanceof CliError && error.code === ERROR_CODE.FAPI_ERROR;
    return {
      name,
      status: "fail",
      message: malformed
        ? "AuthView methods: Clerk returned malformed Frontend API settings"
        : "AuthView methods: the configured Frontend API environment is unavailable",
      remedy:
        "Verify the selected target's development publishable key and Clerk instance, then rerun `clerk doctor`.",
    };
  }
}

function localStepResult(step: IOSSetupStep, platform: IOSNativePlatform): CheckResult {
  const title = doctorStepTitle(step, platform);
  const name = `${platformLabel(platform)}: ${title}`;
  const remedy =
    step.id === "select-target"
      ? step.description
      : step.id === "enable-macos-network" && step.status === "blocked"
        ? step.description
        : step.id === "add-authentication-flow"
          ? AUTH_FLOW_REMEDY
          : LOCAL_STEP_REMEDY;
  switch (step.status) {
    case "satisfied":
      return {
        name,
        status: "pass",
        message: `${title}: configured`,
        detail: step.description,
      };
    case "review":
      return {
        name,
        status: "warn",
        message: `${title}: review needed`,
        detail: step.description,
        remedy: step.description,
      };
    case "required":
      return {
        name,
        status: "fail",
        message: `${title}: setup required`,
        detail: step.description,
        remedy,
      };
    case "blocked":
      return {
        name,
        status: "fail",
        message: `${title}: blocked`,
        detail: step.description,
        remedy,
      };
  }
}

function localResults(
  inspection: IOSProjectInspectionResult,
  sdkInstallPlan?: IOSSDKInstallPlan,
  macOSNetworkCapabilityPlan?: MacOSNetworkCapabilityPlan,
  platformViews?: IOSPlatformViewsSnapshot,
  platformCompatibilityBlockers?: readonly string[],
): CheckResult[] {
  const plan = buildIOSSetupPlan(inspection, {
    sdkInstallPlan,
    macOSNetworkCapabilityPlan,
    productDecision: platformViews?.productDecision,
    platformCompatibilityBlockers,
  });
  const target = selectedTarget(inspection);
  const platform = target?.platform ?? (inspection.platform === "macos" ? "macos" : "ios");
  const results = plan.steps
    .filter(
      (step) =>
        (step.id !== "register-native-application" || step.status === "blocked") &&
        (platform !== "macos" || step.id !== "add-associated-domain"),
    )
    .map((step) => localStepResult(step, step.id === "enable-macos-network" ? "macos" : platform));
  const readiness = buildIOSNativeReadinessAudit(inspection, { platformViews });
  if (
    readiness.target.status === "selected" &&
    readiness.target.appIdPrefix.status === "conflicting"
  ) {
    results.push({
      name: `${platformLabel(platform)}: App ID Prefix evidence`,
      status: "fail",
      message: "App ID Prefix evidence: conflicting values were found",
      detail:
        "The selected target's entitlements contain different literal App ID Prefix values across build configurations.",
      remedy:
        "Make the entitlements consistent and verify the exact App ID Prefix in Apple Developer before rerunning `clerk doctor`.",
    });
  }
  return results;
}

async function appleEntitlementResult(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
  dependencies: IOSDoctorDependencies,
): Promise<CheckResult | undefined> {
  const hasCustomAppleIntent = target.swift.appleAuthReferences.length > 0;
  const anyAppleEntitlement = target.configurations.some(
    (configuration) =>
      configuration.entitlements !== undefined &&
      configuration.entitlements.signInWithAppleState !== "absent",
  );
  if (!hasCustomAppleIntent && !anyAppleEntitlement) return undefined;

  const plan = await dependencies.planIOSAppleEntitlement({
    root: inspection.root,
    projectPath: target.projectPath,
    targetId: target.id,
    platform: target.platform,
    supportedPlatforms: target.supportedPlatforms,
  });
  if (plan.status === "satisfied") {
    return {
      name: `${platformLabel(target.platform)}: Sign in with Apple entitlement`,
      status: "pass",
      message: "Sign in with Apple entitlement: configured",
      detail: "Every selected-target configuration has the exact native Apple entitlement.",
    };
  }

  const detail =
    plan.status === "ready"
      ? plan.actions.join("\n")
      : plan.blockers.map((blocker) => blocker.message).join("\n");
  return {
    name: `${platformLabel(target.platform)}: Sign in with Apple entitlement`,
    status: "fail",
    message: "Sign in with Apple entitlement: incomplete",
    ...(detail ? { detail } : {}),
    remedy:
      "Run `clerk init --target <target> --sign-in-with-apple` to preview and safely add the required capability.",
  };
}

function linkedDevelopmentKeyResult(
  inspection: IOSProjectInspectionResult,
  application: Application,
  developmentInstanceId: string,
): CheckResult {
  const target = selectedTarget(inspection);
  const name = `${platformLabel(target?.platform ?? "ios")}: Linked development key`;
  const localPublishableKey = inspection.localPublishableKey;
  if (localPublishableKey.state !== "valid") {
    return {
      name,
      status: "fail",
      message: "Linked development key: local runtime key was not proven",
      remedy: LOCAL_STEP_REMEDY,
    };
  }
  const localHost = localPublishableKey.frontendApiHost;

  const instance = application.instances.find(
    (candidate) => candidate.instance_id === developmentInstanceId,
  );
  if (!instance) {
    return {
      name,
      status: "fail",
      message: "Linked development key: linked instance is stale",
      remedy: "Run `clerk link` to select a valid development instance.",
    };
  }

  try {
    const linked = decodePublishableKey(instance.publishable_key);
    if (
      localPublishableKey.instanceType !== "development" ||
      linked.instanceType !== "development" ||
      linked.fapiHost !== localHost
    ) {
      return {
        name,
        status: "fail",
        message: "Linked development key: the Xcode target points to a different Clerk instance",
        detail: `Local Frontend API host: ${localHost}\nLinked Frontend API host: ${linked.fapiHost}`,
        remedy: LOCAL_STEP_REMEDY,
      };
    }
    return {
      name,
      status: "pass",
      message: "Linked development key: matches the selected Xcode target",
      detail: `Frontend API host: ${localHost}`,
    };
  } catch {
    return {
      name,
      status: "fail",
      message: "Linked development key: Clerk returned an invalid publishable key",
      remedy: "Relink the project or contact Clerk support before changing the Xcode target.",
    };
  }
}

function linkedCustomApplicationResult(
  application: Application,
  developmentInstanceId: string,
  platform: IOSNativePlatform,
): { result: CheckResult; fapiHost?: string } {
  const name = `${platformLabel(platform)}: Linked Clerk application`;
  const instance = application.instances.find(
    (candidate) => candidate.instance_id === developmentInstanceId,
  );
  if (!instance) {
    return {
      result: {
        name,
        status: "fail",
        message: "Linked Clerk application: linked development instance is stale",
        remedy: "Run `clerk link --app <app_id>` to select a valid application.",
      },
    };
  }

  try {
    const linked = decodePublishableKey(instance.publishable_key);
    if (linked.instanceType !== "development") throw new Error("not a development key");
    return {
      result: {
        name,
        status: "pass",
        message: "Linked Clerk application: selected for remote checks",
        detail:
          "Clerk.configure uses a custom publishable-key source. Doctor did not inspect its value or verify that it belongs to the linked application.",
      },
      fapiHost: linked.fapiHost,
    };
  } catch {
    return {
      result: {
        name,
        status: "fail",
        message: "Linked Clerk application: Clerk returned an invalid development publishable key",
        remedy: "Relink the project or contact Clerk support before changing the Xcode target.",
      },
    };
  }
}

function linkedCustomAssociatedDomainResult(
  target: IOSAppTarget,
  fapiHost: string,
): CheckResult | undefined {
  if (
    target.configurations.length === 0 ||
    target.configurations.some(
      (configuration) =>
        configuration.entitlements == null ||
        configuration.entitlements.unresolvedAssociatedDomains.length > 0,
    )
  ) {
    return undefined;
  }

  const expectedDomain = `webcredentials:${fapiHost}`;
  const configured = target.configurations.every((configuration) =>
    configuration.entitlements!.associatedDomains.some((domain) =>
      associatedDomainMatches(domain, expectedDomain),
    ),
  );
  return configured
    ? {
        name: IOS_ASSOCIATED_DOMAIN_RESULT_NAME,
        status: "pass",
        message: "Clerk's associated domain: matches the linked application",
        detail:
          "The custom publishable-key value was not inspected; this verifies the entitlements against the explicitly linked application.",
      }
    : {
        name: IOS_ASSOCIATED_DOMAIN_RESULT_NAME,
        status: "fail",
        message: "Clerk's associated domain: does not match the linked application",
        detail:
          "The custom publishable-key value was not inspected; this check uses the explicitly linked application.",
        remedy:
          "Run `clerk init --target <target> --app <app_id>` to preview and add the linked application's exact domain.",
      };
}

async function remoteResults(
  ctx: DoctorContext,
  inspection: IOSProjectInspectionResult,
  dependencies: IOSDoctorDependencies,
  platformViews?: IOSPlatformViewsSnapshot,
): Promise<CheckResult[]> {
  const readiness = buildIOSNativeReadinessAudit(inspection, { platformViews });
  const target = selectedTarget(inspection);
  const platform = target?.platform ?? (inspection.platform === "macos" ? "macos" : "ios");
  const nativeApplicationName = `${platformLabel(platform)}: Native Application`;
  const appleResultName = `${platformLabel(platform)}: Clerk Sign in with Apple`;
  const configureStep = buildIOSSetupPlan(inspection).steps.find(
    (step) => step.id === "configure-publishable-key",
  );
  const customSource =
    target != null &&
    configureStep?.status === "satisfied" &&
    hasSupportedIOSCustomConfigure(target);
  const preliminaryResults: CheckResult[] = [];

  if (
    readiness.target.status === "selected" &&
    (readiness.target.bundleIdentifier.status !== "resolved" ||
      readiness.target.appIdPrefix.status === "conflicting")
  ) {
    // These are fully local identity failures. Avoid hiding them behind an
    // authentication/network warning or asking the remote API about an
    // identity that the selected Xcode target did not prove.
    return preliminaryResults;
  }

  const profile = await ctx.getProfile();
  if (!profile) {
    if (target) {
      const authView = await authViewEnvironmentResult(target, dependencies, {
        root: inspection.root,
        configureStatus: configureStep?.status,
        customSource,
        linked: false,
      });
      if (authView) preliminaryResults.push(authView);
    }
    return [
      ...preliminaryResults,
      {
        name: nativeApplicationName,
        status: "warn",
        message: "Native Application: remote state not inspected (project is not linked)",
        remedy: customSource
          ? "Run `clerk link --app <app_id>` for the intended Clerk application, then rerun `clerk doctor`."
          : "Run `clerk link`, then rerun `clerk doctor`.",
      },
    ];
  }

  if (readiness.target.status !== "selected") {
    return [
      ...preliminaryResults,
      {
        name: nativeApplicationName,
        status: "warn",
        message: `Native Application: remote state not inspected (select one ${platformLabel(platform)} target)`,
        remedy: "Rerun with `clerk doctor --target <name-or-id>`.",
      },
    ];
  }

  const applicationId = profile.profile.appId;
  const instanceId = profile.profile.instances.development;
  try {
    const [application, remotePlan] = await Promise.all([
      dependencies.fetchApplication(applicationId, {
        includeSecretKeys: false,
      }),
      auditIOSNativeRemoteSetup(
        { applicationId, instanceId, target: readiness.target },
        {
          getNativeSettings: dependencies.getNativeSettings,
          listIOSApplications: dependencies.listIOSApplications,
        },
      ),
    ]);
    const customApplication = customSource
      ? linkedCustomApplicationResult(application, instanceId, platform)
      : undefined;
    const linkedResult =
      customApplication?.result ??
      (configureStep?.status === "satisfied"
        ? linkedDevelopmentKeyResult(inspection, application, instanceId)
        : undefined);
    const localPublishableKey = inspection.localPublishableKey;
    const verifiedFapiHost =
      customApplication?.fapiHost ??
      (!customSource && linkedResult?.status === "pass" && localPublishableKey.state === "valid"
        ? localPublishableKey.frontendApiHost
        : undefined);
    if (target) {
      const authView = await authViewEnvironmentResult(target, dependencies, {
        root: inspection.root,
        configureStatus: configureStep?.status,
        fapiHost: verifiedFapiHost,
        customSource,
        linked: true,
      });
      if (authView) preliminaryResults.push(authView);
    }
    const customAssociatedDomain =
      platform === "ios" && target && customApplication?.fapiHost
        ? linkedCustomAssociatedDomainResult(target, customApplication.fapiHost)
        : undefined;
    const results = [
      ...preliminaryResults,
      ...(linkedResult ? [linkedResult] : []),
      ...(customAssociatedDomain ? [customAssociatedDomain] : []),
    ];
    if (remotePlan.status === "satisfied") {
      results.push({
        name: nativeApplicationName,
        status: "pass",
        message: `Native API and ${platformLabel(platform)} registration: configured`,
        detail: remotePlan.bundleIdentifier
          ? `Bundle ID: ${remotePlan.bundleIdentifier}`
          : undefined,
      });
    } else {
      const detail =
        remotePlan.status === "ready"
          ? remotePlan.actions.join("\n")
          : remotePlan.blockers.map((blocker) => blocker.message).join("\n");
      results.push({
        name: nativeApplicationName,
        status: "fail",
        message:
          remotePlan.status === "ready"
            ? `Native API or ${platformLabel(platform)} registration: setup required`
            : `Native API or ${platformLabel(platform)} registration: blocked`,
        ...(detail ? { detail } : {}),
        remedy: REMOTE_REMEDY,
      });
    }

    const bundleIdentifier = readiness.target.bundleIdentifier;
    const hasAppleEntitlement = target?.configurations.some(
      (configuration) =>
        configuration.entitlements !== undefined &&
        configuration.entitlements.signInWithAppleState !== "absent",
    );
    const hasCustomAppleIntent = (target?.swift.appleAuthReferences.length ?? 0) > 0;
    if (
      (hasAppleEntitlement || hasCustomAppleIntent) &&
      bundleIdentifier.status === "resolved" &&
      remotePlan.registration === "satisfied"
    ) {
      const registeredBundleIdentifier = remotePlan.bundleIdentifier;
      if (!registeredBundleIdentifier) {
        throw new Error("A satisfied iOS registration must include its Bundle ID.");
      }
      try {
        const apple = await dependencies.auditIOSNativeAppleHealth({
          applicationId,
          instanceId,
          platform,
          bundleIdentifier: registeredBundleIdentifier,
        });
        if (apple.runtime.status === "satisfied") {
          results.push({
            name: appleResultName,
            status: "pass",
            message: "Clerk Sign in with Apple: configured for the selected Bundle ID",
            detail:
              apple.automation.status === "supported"
                ? "The current connection is healthy; no automatic repair is required."
                : "The current connection is healthy; automatic repair is unavailable for this instance.",
          });
        } else if (apple.runtime.status === "required") {
          const automationSupported = apple.automation.status === "supported";
          const automationDetail = apple.automation.blockers
            .map((blocker) => blocker.message)
            .join("\n");
          results.push({
            name: appleResultName,
            status: "fail",
            message:
              apple.runtime.bundleIdentifierConfiguration === "required"
                ? "Clerk Sign in with Apple: the connection is not bound to the selected Bundle ID"
                : hasAppleEntitlement
                  ? "Clerk Sign in with Apple: local entitlement is present but the connection is disabled"
                  : "Clerk Sign in with Apple: custom Apple sign-in is referenced but the connection is disabled",
            ...(!automationSupported
              ? {
                  detail:
                    automationDetail ||
                    "Automatic native Sign in with Apple repair is unavailable for this instance.",
                }
              : {}),
            remedy: automationSupported
              ? "Run `clerk init --target <target> --sign-in-with-apple` if this app should offer Apple sign-in."
              : "Review the Apple connection in the Clerk Dashboard or contact Clerk support, then rerun `clerk doctor`.",
          });
        } else {
          results.push({
            name: appleResultName,
            status: "fail",
            message: "Clerk Sign in with Apple: configuration conflict",
            detail: apple.runtime.blockers.map((blocker) => blocker.message).join("\n"),
            remedy: "Review the Apple connection in Clerk Dashboard, then rerun `clerk doctor`.",
          });
        }
      } catch (error) {
        if (error instanceof PlapiError && error.status === 403) {
          results.push({
            name: appleResultName,
            status: "fail",
            message: "Clerk Sign in with Apple: application access is not permitted",
            remedy:
              "Use an account or Platform API key with applications:manage access to the linked app.",
          });
        } else if (isAuthError(error) || (error instanceof PlapiError && error.status === 401)) {
          results.push({
            name: appleResultName,
            status: "fail",
            message: "Clerk Sign in with Apple: Clerk authentication is invalid",
            remedy: "Run `clerk auth login`, then rerun `clerk doctor`.",
          });
        } else if (error instanceof PlapiError && error.status === 404) {
          results.push({
            name: appleResultName,
            status: "fail",
            message: "Clerk Sign in with Apple: the linked app or instance was not found",
            remedy: "Run `clerk link` to refresh this project's application and instance IDs.",
          });
        } else {
          results.push({
            name: appleResultName,
            status: "warn",
            message: "Clerk Sign in with Apple: remote state could not be inspected",
            remedy: "Check your Clerk authentication and network connection, then rerun doctor.",
          });
        }
      }
    }
    return results;
  } catch (error) {
    if (error instanceof CliError && error.code === ERROR_CODE.PLAPI_UNEXPECTED_RESPONSE) {
      return [
        ...preliminaryResults,
        {
          name: nativeApplicationName,
          status: "fail",
          message: "Native Application: Clerk returned an invalid remote response",
          remedy:
            "Update the Clerk CLI, rerun `clerk doctor`, and contact Clerk support if the response remains invalid.",
        },
      ];
    }
    if (error instanceof PlapiError && error.status === 403) {
      return [
        ...preliminaryResults,
        {
          name: nativeApplicationName,
          status: "fail",
          message: "Native Application: application access is not permitted",
          remedy:
            "Use an account or Platform API key with applications:read access to the linked app.",
        },
      ];
    }
    if (isAuthError(error) || (error instanceof PlapiError && error.status === 401)) {
      return [
        ...preliminaryResults,
        {
          name: nativeApplicationName,
          status: "fail",
          message: "Native Application: Clerk authentication is invalid",
          remedy: "Run `clerk auth login`, then rerun `clerk doctor`.",
        },
      ];
    }
    if (error instanceof PlapiError && error.status === 404) {
      return [
        ...preliminaryResults,
        {
          name: nativeApplicationName,
          status: "fail",
          message: "Native Application: the linked app or development instance was not found",
          remedy: "Run `clerk link` to refresh this project's application and instance IDs.",
        },
      ];
    }
    return [
      ...preliminaryResults,
      {
        name: nativeApplicationName,
        status: "warn",
        message: "Native Application: remote state could not be inspected",
        remedy:
          "Check your Clerk authentication and network connection, then rerun `clerk doctor`.",
      },
    ];
  }
}

export async function runIOSDoctorChecks(
  ctx: DoctorContext,
  options: IOSDoctorOptions,
  dependencies: IOSDoctorDependencies = defaultDependencies,
): Promise<{ inspection: IOSProjectInspectionResult; results: CheckResult[] }> {
  const inspection =
    options.preparedInspection ??
    (await dependencies.inspectIOSProject(options.root, {
      target: options.target,
      exhaustiveContainerDiscovery: true,
    }));
  const target = selectedTarget(inspection);
  const platformViewsAudit = target
    ? await inspectIOSPlatformViews(inspection, dependencies.inspectIOSProject)
    : undefined;
  const platformViews =
    platformViewsAudit?.status === "ready" ? platformViewsAudit.snapshot : undefined;
  const platformCompatibilityBlockers =
    platformViewsAudit?.status === "blocked"
      ? platformViewsAudit.blockers.map((blocker) => blocker.message)
      : undefined;
  const requiresAuthViewCompatibility = platformViews?.requiresAuthViewCompatibility === true;
  const requiresClerkKitUI = platformViews?.requiresClerkKitUI === true;
  const sdkInstallPlan =
    target?.platformEvidenceComplete && platformViews
      ? await dependencies.planIOSSDKInstall({
          root: inspection.root,
          projectPath: target.projectPath,
          targetId: target.id,
          platform: target.platform,
          supportedPlatforms: target.supportedPlatforms,
          ...(requiresClerkKitUI ? { includeClerkKitUI: true } : {}),
          ...(requiresAuthViewCompatibility ? { requirePrebuiltAuthCompatibility: true } : {}),
        })
      : undefined;
  const macOSNetworkCapabilityPlan =
    platformViews && target?.supportedPlatforms.includes("macos")
      ? await dependencies.planMacOSNetworkCapability({
          root: inspection.root,
          projectPath: target.projectPath,
          targetId: target.id,
          allowMissingEntitlementsCreation: true,
        })
      : undefined;
  const results = localResults(
    inspection,
    sdkInstallPlan,
    macOSNetworkCapabilityPlan,
    platformViews,
    platformCompatibilityBlockers,
  );
  if (platformViewsAudit?.status === "blocked") {
    return { inspection, results };
  }
  if (target && !target.platformEvidenceComplete) {
    return { inspection, results };
  }
  if (target) {
    const apple = await appleEntitlementResult(inspection, target, dependencies);
    if (apple) results.splice(Math.max(0, results.length - 1), 0, apple);
  }
  if (target && !platformViews) return { inspection, results };
  for (const remoteResult of await remoteResults(ctx, inspection, dependencies, platformViews)) {
    const existingIndex =
      remoteResult.name === IOS_ASSOCIATED_DOMAIN_RESULT_NAME
        ? results.findIndex((result) => result.name === remoteResult.name)
        : -1;
    if (existingIndex === -1) {
      results.push(remoteResult);
    } else {
      results[existingIndex] = remoteResult;
    }
  }
  return { inspection, results };
}
