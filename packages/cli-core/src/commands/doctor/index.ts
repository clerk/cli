import type { Program } from "../../cli-program.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { bold, green, red } from "../../lib/color.ts";
import { detectFramework } from "../../lib/framework.ts";
import { log } from "../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../lib/errors.ts";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.ts";
import { setTelemetryStage } from "../../lib/telemetry.ts";
import { inspectIOSProject } from "../init/ios/inspect.ts";
import { createDoctorContext } from "./context.ts";
import {
  checkLoggedIn,
  checkHostExecution,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
  checkEnvVars,
  checkConfigFile,
  checkShellCompletion,
  checkCliVersion,
} from "./checks.ts";
import { checkMcp } from "./check-mcp.ts";
import { formatCheckResult, formatJson } from "./format.ts";
import { runIOSDoctorChecks } from "./ios.ts";
import type { CheckFn, CheckResult, DoctorContext, DoctorOptions } from "./types.ts";

const ACCOUNT_CHECKS: CheckFn[] = [
  checkCliVersion,
  checkLoggedIn,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
];

const CONFIGURATION_CHECKS: CheckFn[] = [checkConfigFile, checkShellCompletion, checkMcp];

export function getDoctorChecks(appleNative: boolean): CheckFn[] {
  const checks = [
    ...ACCOUNT_CHECKS,
    ...(appleNative ? [] : [checkEnvVars]),
    ...CONFIGURATION_CHECKS,
  ];
  return isAgent() ? [checkHostExecution, ...checks] : checks;
}

export interface DoctorRunDependencies {
  detectFramework: typeof detectFramework;
  inspectIOSProject: typeof inspectIOSProject;
  getDoctorChecks: typeof getDoctorChecks;
  runIOSDoctorChecks: typeof runIOSDoctorChecks;
}

const defaultDoctorRunDependencies: DoctorRunDependencies = {
  detectFramework,
  inspectIOSProject,
  getDoctorChecks,
  runIOSDoctorChecks,
};

interface RunChecksOptions {
  initialStage?: "doctor_checks" | "doctor_verify";
  dependencies?: DoctorRunDependencies;
}

export async function runChecks(
  ctx: DoctorContext,
  options: DoctorOptions,
  runOptions: RunChecksOptions = {},
): Promise<CheckResult[]> {
  const dependencies = runOptions.dependencies ?? defaultDoctorRunDependencies;
  setTelemetryStage(runOptions.initialStage ?? "doctor_checks");
  const explicitlyRequestsAppleNative = options.target != null;
  const framework = explicitlyRequestsAppleNative
    ? { dep: "ios" }
    : await dependencies.detectFramework(process.cwd());
  const appleNativeCandidate = framework?.dep === "ios";
  let appleNativeInspection: Awaited<ReturnType<typeof inspectIOSProject>> | undefined;
  let appleNativeInspectionFailed = false;
  if (appleNativeCandidate) {
    try {
      appleNativeInspection = await dependencies.inspectIOSProject(process.cwd(), {
        ...(options.target ? { target: options.target } : {}),
        exhaustiveContainerDiscovery: true,
      });
    } catch {
      appleNativeInspectionFailed = true;
    }
  }
  const fatalAppleNativeInspectionDiagnostic =
    appleNativeInspection?.appTargets.length === 0 &&
    appleNativeInspection.selection.state === "none"
      ? appleNativeInspection.diagnostics.find(
          (diagnostic) =>
            diagnostic.severity === "error" && diagnostic.code !== "xcode.no-ios-app-target",
        )
      : undefined;
  const appleNative =
    appleNativeInspectionFailed ||
    fatalAppleNativeInspectionDiagnostic != null ||
    options.target != null ||
    (appleNativeInspection?.appTargets.length ?? 0) > 0;
  const common = await Promise.all(
    dependencies.getDoctorChecks(appleNative).map(async (check) => {
      try {
        return await check(ctx);
      } catch (error) {
        return {
          name: "Unknown check",
          status: "fail" as const,
          message: `Check crashed: ${errorMessage(error)}`,
        };
      }
    }),
  );

  if (!appleNativeCandidate) return common;
  if (appleNativeInspectionFailed || !appleNativeInspection) {
    return [
      ...common,
      {
        name: "Apple-native inspection",
        status: "fail",
        message: "Apple-native project inspection failed",
        detail: "The semantic Xcode inspection did not complete safely.",
        remedy: "Run from the Xcode project root and pass `--target <name-or-id>` if needed.",
      },
    ];
  }
  if (fatalAppleNativeInspectionDiagnostic) {
    return [
      ...common,
      {
        name: "Apple-native inspection",
        status: "fail",
        message: "Apple-native project inspection failed",
        detail: fatalAppleNativeInspectionDiagnostic.message,
        remedy:
          fatalAppleNativeInspectionDiagnostic.remedy ??
          "Run from the Xcode project root and verify that its project files are readable.",
      },
    ];
  }
  if (!appleNative) return common;

  let appleNativeChecks: Awaited<ReturnType<typeof runIOSDoctorChecks>>;
  try {
    setTelemetryStage("doctor_ios_audit");
    appleNativeChecks = await dependencies.runIOSDoctorChecks(ctx, {
      root: process.cwd(),
      ...(options.target ? { target: options.target } : {}),
      preparedInspection: appleNativeInspection,
    });
  } catch {
    return [
      ...common,
      {
        name: "Apple-native inspection",
        status: "fail",
        message: "Apple-native project inspection failed",
        detail: "The semantic Xcode inspection did not complete safely.",
        remedy: "Run from the Xcode project root and pass `--target <name-or-id>` if needed.",
      },
    ];
  }
  return [...common, ...appleNativeChecks.results];
}

function printResults(results: CheckResult[], options: DoctorOptions): void {
  for (const result of results) {
    if (!options.spotlight || result.status !== "pass") {
      log.info(formatCheckResult(result, options.verbose ?? false));
    }
  }
  log.blank();
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  if (!options.json) {
    intro("Running diagnostics");
  }

  const ctx = createDoctorContext();
  const allResults = await withSpinner("Running diagnostics...", async () =>
    runChecks(ctx, options),
  );

  if (!options.json) {
    printResults(allResults, options);
  }

  if (options.json) {
    const output = options.spotlight ? allResults.filter((r) => r.status !== "pass") : allResults;
    log.data(formatJson(output));
  }

  if (options.fix && !options.json && isHuman()) {
    const fixable = allResults.filter((r) => r.status !== "pass" && r.fix);

    const seen = new Set<string>();
    const uniqueFixable = fixable.filter((r) => {
      const label = r.fix?.label;
      if (!label || seen.has(label)) return false;
      seen.add(label);
      return true;
    });

    if (uniqueFixable.length > 0) {
      setTelemetryStage("doctor_fix");
      log.blank();
      log.info(bold("Auto-fix"));
      log.blank();

      const { confirm } = await import("../../lib/prompts.ts");

      for (const result of uniqueFixable) {
        const fix = result.fix;
        if (!fix) continue;
        const proceed = await confirm({
          message: `Fix "${result.name}"? (${fix.label})`,
          default: true,
        });

        if (proceed) {
          try {
            await fix.run();
            log.info(`  ${green("✓")} ${result.name} fixed`);
          } catch (error) {
            log.info(`  ${red("✗")} Fix failed: ${errorMessage(error)}`);
          }
        }
      }

      bar();

      const verifyCtx = createDoctorContext();
      const verifyResults = await withSpinner("Verifying fixes...", async () =>
        runChecks(verifyCtx, options, { initialStage: "doctor_verify" }),
      );
      printResults(verifyResults, { ...options, fix: false, spotlight: false });

      const hasVerifyFailure = verifyResults.some((r) => r.status === "fail");
      if (hasVerifyFailure) {
        throw new CliError("Some checks still failing after auto-fix", {
          code: ERROR_CODE.DOCTOR_FAILED,
        });
      }
      setTelemetryStage("done");
      await outro("All checks passing");
      return;
    }
  }

  const hasFailure = allResults.some((r) => r.status === "fail");
  if (hasFailure) {
    throw new CliError("Doctor found issues with your Clerk integration", {
      code: ERROR_CODE.DOCTOR_FAILED,
    });
  }
  setTelemetryStage("done");
  await outro("All checks passing");
}

export function registerDoctor(program: Program): void {
  program
    .command("doctor")
    .description("Check your project's Clerk integration health")
    .option("--verbose", "Show detailed output for each check")
    .option("--json", "Output results as JSON")
    .option("--spotlight", "Only show warnings and failures")
    .option("--fix", "Attempt to auto-fix issues")
    .option("--target <name-or-id>", "Select an iOS or macOS application target")
    .setExamples([
      { command: "clerk doctor", description: "Run all health checks" },
      { command: "clerk doctor --verbose", description: "Show detailed output for each check" },
      { command: "clerk doctor --json", description: "Output results as machine-readable JSON" },
      { command: "clerk doctor --fix", description: "Auto-fix detected issues" },
      { command: "clerk doctor --spotlight", description: "Only show warnings and failures" },
      {
        command: "clerk doctor --target MyApp",
        description: "Audit a specific iOS or macOS application target",
      },
    ])
    .action(doctor);
}
