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
import { auditIOSPrebuiltAuthEnvironment } from "../init/ios/prebuilt-auth-environment.ts";
import { inspectIOSProject } from "../init/ios/inspect.ts";
import { auditIOSNativeAppleHealth } from "../init/ios/native-apple.ts";
import { buildIOSNativeReadinessAudit } from "../init/ios/native-readiness.ts";
import { auditIOSNativeRemoteSetup } from "../init/ios/native-remote.ts";
import { buildIOSSetupPlan } from "../init/ios/plan.ts";
import type { IOSAppTarget, IOSProjectInspectionResult, IOSSetupStep } from "../init/ios/types.ts";
import type { CheckResult, DoctorContext } from "./types.ts";

const LOCAL_STEP_REMEDY = "Run `clerk init --target <target>` to safely complete this step.";
const REMOTE_REMEDY =
  "Run `clerk init --target <target>` to preview and apply the missing Native Application setup.";

export interface IOSDoctorOptions {
  root: string;
  target?: string;
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
};

function selectedTarget(inspection: IOSProjectInspectionResult): IOSAppTarget | undefined {
  const selection = inspection.selection;
  if (selection.state !== "selected") return undefined;
  return inspection.appTargets.find(
    (target) => target.id === selection.targetId && target.projectPath === selection.projectPath,
  );
}

async function authViewEnvironmentResult(
  inspection: IOSProjectInspectionResult,
  target: IOSAppTarget,
  dependencies: IOSDoctorDependencies,
): Promise<CheckResult | undefined> {
  if (target.swift.authViewReferences.length === 0) return undefined;

  const name = "iOS: AuthView authentication methods";
  const configureStep = buildIOSSetupPlan(inspection).steps.find(
    (step) => step.id === "configure-publishable-key",
  );
  const fapiHost = inspection.localPublishableKey.frontendApiHost;
  if (configureStep?.status !== "satisfied" || !fapiHost) {
    return {
      name,
      status: "warn",
      message: "AuthView methods: remote state not inspected (runtime key was not proven)",
      remedy: LOCAL_STEP_REMEDY,
    };
  }

  try {
    const environment = dependencies.auditIOSPrebuiltAuthEnvironment(
      await dependencies.fetchUserSettings(fapiHost, {}),
    );
    if (environment.apple === "blocked") {
      return {
        name,
        status: "fail",
        message: "AuthView methods: Clerk returned an unsupported Apple provider state",
        remedy: "Review the Apple connection in Clerk Dashboard, then rerun `clerk doctor`.",
      };
    }
    if (environment.apple === "not-required") {
      return {
        name,
        status: "pass",
        message: "AuthView methods: native Apple sign-in is not currently offered",
      };
    }

    const entitlementIsComplete =
      target.configurations.length > 0 &&
      target.configurations.every(
        (configuration) => configuration.entitlements?.signInWithApple === true,
      );
    return entitlementIsComplete
      ? {
          name,
          status: "pass",
          message: "AuthView methods: Apple is enabled and the local entitlement is present",
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

function localStepResult(step: IOSSetupStep): CheckResult {
  const name = `iOS: ${step.title}`;
  switch (step.status) {
    case "satisfied":
      return {
        name,
        status: "pass",
        message: `${step.title}: configured`,
        detail: step.description,
      };
    case "review":
      return {
        name,
        status: "warn",
        message: `${step.title}: review needed`,
        detail: step.description,
        remedy: step.description,
      };
    case "required":
      return {
        name,
        status: "fail",
        message: `${step.title}: setup required`,
        detail: step.description,
        remedy: LOCAL_STEP_REMEDY,
      };
    case "blocked":
      return {
        name,
        status: "fail",
        message: `${step.title}: blocked`,
        detail: step.description,
        remedy: step.id === "select-target" ? step.description : LOCAL_STEP_REMEDY,
      };
  }
}

function localResults(inspection: IOSProjectInspectionResult): CheckResult[] {
  const plan = buildIOSSetupPlan(inspection);
  const results = plan.steps
    .filter((step) => step.id !== "register-native-application" || step.status === "blocked")
    .map(localStepResult);
  const readiness = buildIOSNativeReadinessAudit(inspection);
  if (
    readiness.target.status === "selected" &&
    readiness.target.appIdPrefix.status === "conflicting"
  ) {
    results.push({
      name: "iOS: App ID Prefix evidence",
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
  const anyAppleEntitlement = target.configurations.some(
    (configuration) => configuration.entitlements?.signInWithApple === true,
  );
  if (!anyAppleEntitlement) return undefined;

  const plan = await dependencies.planIOSAppleEntitlement({
    root: inspection.root,
    projectPath: target.projectPath,
    targetId: target.id,
  });
  if (plan.status === "satisfied") {
    return {
      name: "iOS: Sign in with Apple entitlement",
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
    name: "iOS: Sign in with Apple entitlement",
    status: "fail",
    message: "Sign in with Apple entitlement: incomplete",
    ...(detail ? { detail } : {}),
    remedy: LOCAL_STEP_REMEDY,
  };
}

function linkedDevelopmentKeyResult(
  inspection: IOSProjectInspectionResult,
  application: Application,
  developmentInstanceId: string,
): CheckResult {
  const name = "iOS: Linked development key";
  const localHost = inspection.localPublishableKey.frontendApiHost;
  if (!localHost) {
    return {
      name,
      status: "fail",
      message: "Linked development key: local runtime key was not proven",
      remedy: LOCAL_STEP_REMEDY,
    };
  }

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
      inspection.localPublishableKey.instanceType !== "development" ||
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

async function remoteResults(
  ctx: DoctorContext,
  inspection: IOSProjectInspectionResult,
  dependencies: IOSDoctorDependencies,
): Promise<CheckResult[]> {
  const readiness = buildIOSNativeReadinessAudit(inspection);
  const target = selectedTarget(inspection);
  const preliminaryResults: CheckResult[] = [];
  if (target) {
    const authView = await authViewEnvironmentResult(inspection, target, dependencies);
    if (authView) preliminaryResults.push(authView);
  }

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
    return [
      ...preliminaryResults,
      {
        name: "iOS: Native Application",
        status: "warn",
        message: "Native Application: remote state not inspected (project is not linked)",
        remedy: "Run `clerk link`, then rerun `clerk doctor`.",
      },
    ];
  }

  if (readiness.target.status !== "selected") {
    return [
      ...preliminaryResults,
      {
        name: "iOS: Native Application",
        status: "warn",
        message: "Native Application: remote state not inspected (select one iOS target)",
        remedy: "Rerun with `clerk doctor --target <name-or-id>`.",
      },
    ];
  }

  const applicationId = profile.profile.appId;
  const instanceId = profile.profile.instances.development;
  try {
    const [application, remotePlan] = await Promise.all([
      dependencies.fetchApplication(applicationId, { includeSecretKeys: false }),
      auditIOSNativeRemoteSetup(
        { applicationId, instanceId, target: readiness.target },
        {
          getNativeSettings: dependencies.getNativeSettings,
          listIOSApplications: dependencies.listIOSApplications,
        },
      ),
    ]);
    const configureStep = buildIOSSetupPlan(inspection).steps.find(
      (step) => step.id === "configure-publishable-key",
    );
    const linkedKeyResult =
      configureStep?.status === "satisfied"
        ? linkedDevelopmentKeyResult(inspection, application, instanceId)
        : undefined;
    const results = [...preliminaryResults, ...(linkedKeyResult ? [linkedKeyResult] : [])];
    if (remotePlan.status === "satisfied") {
      results.push({
        name: "iOS: Native Application",
        status: "pass",
        message: "Native API and iOS registration: configured",
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
        name: "iOS: Native Application",
        status: "fail",
        message:
          remotePlan.status === "ready"
            ? "Native API or iOS registration: setup required"
            : "Native API or iOS registration: blocked",
        ...(detail ? { detail } : {}),
        remedy: REMOTE_REMEDY,
      });
    }

    const bundleIdentifier = readiness.target.bundleIdentifier;
    const hasAppleEntitlement = target?.configurations.some(
      (configuration) => configuration.entitlements?.signInWithApple === true,
    );
    if (
      hasAppleEntitlement &&
      bundleIdentifier.status === "resolved" &&
      remotePlan.registration === "satisfied"
    ) {
      try {
        const apple = await dependencies.auditIOSNativeAppleHealth({
          applicationId,
          instanceId,
          bundleIdentifier: bundleIdentifier.value,
        });
        if (apple.runtime.status === "satisfied") {
          results.push({
            name: "iOS: Clerk Sign in with Apple",
            status: "pass",
            message: "Clerk Sign in with Apple: configured for the selected Bundle ID",
            detail:
              apple.automation.status === "supported"
                ? "The current connection is healthy and can be reconciled by clerk init."
                : "The current connection is healthy; automatic repair is unavailable for this instance.",
          });
        } else if (apple.runtime.status === "required") {
          results.push({
            name: "iOS: Clerk Sign in with Apple",
            status: "fail",
            message:
              apple.runtime.bundleIdentifierConfiguration === "required"
                ? "Clerk Sign in with Apple: the connection is not bound to the selected Bundle ID"
                : "Clerk Sign in with Apple: local entitlement is present but the connection is disabled",
            remedy:
              "Run `clerk init --target <target> --sign-in-with-apple` if this app should offer Apple sign-in.",
          });
        } else {
          results.push({
            name: "iOS: Clerk Sign in with Apple",
            status: "fail",
            message: "Clerk Sign in with Apple: configuration conflict",
            detail: apple.runtime.blockers.map((blocker) => blocker.message).join("\n"),
            remedy: "Review the Apple connection in Clerk Dashboard, then rerun `clerk doctor`.",
          });
        }
      } catch (error) {
        if (error instanceof PlapiError && error.status === 403) {
          results.push({
            name: "iOS: Clerk Sign in with Apple",
            status: "fail",
            message: "Clerk Sign in with Apple: application access is not permitted",
            remedy:
              "Use an account or Platform API key with applications:read access to the linked app.",
          });
        } else if (isAuthError(error) || (error instanceof PlapiError && error.status === 401)) {
          results.push({
            name: "iOS: Clerk Sign in with Apple",
            status: "fail",
            message: "Clerk Sign in with Apple: Clerk authentication is invalid",
            remedy: "Run `clerk auth login`, then rerun `clerk doctor`.",
          });
        } else if (error instanceof PlapiError && error.status === 404) {
          results.push({
            name: "iOS: Clerk Sign in with Apple",
            status: "fail",
            message: "Clerk Sign in with Apple: the linked app or instance was not found",
            remedy: "Run `clerk link` to refresh this project's application and instance IDs.",
          });
        } else {
          results.push({
            name: "iOS: Clerk Sign in with Apple",
            status: "warn",
            message: "Clerk Sign in with Apple: remote state could not be inspected",
            remedy: "Check your Clerk authentication and network connection, then rerun doctor.",
          });
        }
      }
    }
    return results;
  } catch (error) {
    if (error instanceof PlapiError && error.status === 403) {
      return [
        ...preliminaryResults,
        {
          name: "iOS: Native Application",
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
          name: "iOS: Native Application",
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
          name: "iOS: Native Application",
          status: "fail",
          message: "Native Application: the linked app or development instance was not found",
          remedy: "Run `clerk link` to refresh this project's application and instance IDs.",
        },
      ];
    }
    return [
      ...preliminaryResults,
      {
        name: "iOS: Native Application",
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
  const inspection = await dependencies.inspectIOSProject(options.root, {
    target: options.target,
    exhaustiveContainerDiscovery: true,
  });
  const results = localResults(inspection);
  const target = selectedTarget(inspection);
  if (target) {
    const apple = await appleEntitlementResult(inspection, target, dependencies);
    if (apple) results.splice(Math.max(0, results.length - 1), 0, apple);
  }
  results.push(...(await remoteResults(ctx, inspection, dependencies)));
  return { inspection, results };
}
