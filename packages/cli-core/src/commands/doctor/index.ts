import type { Program } from "../../cli-program.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { bold, green, red } from "../../lib/color.ts";
import { detectFramework } from "../../lib/framework.ts";
import { log } from "../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../lib/errors.ts";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.ts";
import { setTelemetryStage } from "../../lib/telemetry.ts";
import { interruptSignal } from "../../lib/signals.ts";
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
import {
  CHECK_NAME,
  type CheckFn,
  type CheckKey,
  type CheckResult,
  type DoctorContext,
  type DoctorOptions,
} from "./types.ts";

/**
 * Every check, keyed by its entry in {@link CHECK_NAME} so the compiler rejects
 * a missing one — before this, a check that was exported but never listed
 * simply did not run, and nothing said so. Listed in the order they run; that
 * order is read from here, not from `CHECK_NAME`. `hostExecution` leads
 * because it runs first under an agent and not at all for a human.
 */
const CHECKS = {
  hostExecution: checkHostExecution,
  cliVersion: checkCliVersion,
  loggedIn: checkLoggedIn,
  tokenValid: checkTokenValid,
  projectLinked: checkProjectLinked,
  linkedAppExists: checkLinkedAppExists,
  instances: checkInstances,
  envVars: checkEnvVars,
  configFile: checkConfigFile,
  shellCompletion: checkShellCompletion,
  mcp: checkMcp,
} satisfies Record<CheckKey, CheckFn>;

/**
 * Each check paired with the name to report it under if it throws. A check
 * names its own results from the same `CHECK_NAME` entry, so the two agree.
 */
export function getDoctorChecks(appleNative: boolean): { name: string; run: CheckFn }[] {
  return (Object.keys(CHECKS) as CheckKey[])
    .filter((key) => (key !== "hostExecution" || isAgent()) && (key !== "envVars" || !appleNative))
    .map((key) => ({ name: CHECK_NAME[key], run: CHECKS[key] }));
}

export interface DoctorRunDependencies {
  detectFramework: typeof detectFramework;
  getDoctorChecks: typeof getDoctorChecks;
  runIOSDoctorChecks: typeof runIOSDoctorChecks;
}

const defaultDoctorRunDependencies: DoctorRunDependencies = {
  detectFramework,
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
  const explicitlyRequestsAppleNative =
    options.target != null || options.project != null || options.configuration != null;
  const framework = explicitlyRequestsAppleNative
    ? { dep: "ios" }
    : await dependencies.detectFramework(process.cwd());
  const appleNativeCandidate = framework?.dep === "ios";
  const appleNative = appleNativeCandidate;
  const common = await Promise.all(
    dependencies.getDoctorChecks(appleNative).map(async ({ name, run }) => {
      try {
        return await run(ctx);
      } catch (error) {
        return {
          name,
          status: "fail" as const,
          message: `${name} check crashed: ${errorMessage(error)}`,
          crashed: true as const,
        };
      }
    }),
  );

  if (!appleNativeCandidate) return common;
  let appleNativeChecks: Awaited<ReturnType<typeof runIOSDoctorChecks>>;
  try {
    setTelemetryStage("doctor_ios_audit");
    appleNativeChecks = await dependencies.runIOSDoctorChecks(ctx, {
      root: process.cwd(),
      ...(options.target ? { target: options.target } : {}),
      project: options.project,
      configuration: options.configuration,
    });
  } catch {
    interruptSignal().throwIfAborted();
    return [
      ...common,
      {
        name: "Apple-native inspection",
        status: "fail",
        message: "Apple-native project inspection failed",
        detail:
          "Xcode could not inspect the selected project. Open it in a compatible Xcode and retry.",
        remedy: "Run from the Xcode project root and pass `--target <name-or-id>` if needed.",
      },
    ];
  }
  return [...common, ...appleNativeChecks.results];
}

/**
 * The error for a set of results that includes a failure. A crashed check is a
 * CLI bug, not a problem with the user's project, so both the message and the
 * code say so. After `--fix` this is decided from the verify pass alone.
 */
function failureFor(results: CheckResult[], findingsMessage: string): CliError {
  const crashed = results.some((r) => r.crashed);
  return new CliError(
    crashed
      ? "A doctor check crashed. This is a bug in the Clerk CLI, not your project; see the check marked as crashed above."
      : findingsMessage,
    { code: crashed ? ERROR_CODE.DOCTOR_CHECK_CRASHED : ERROR_CODE.DOCTOR_FAILED },
  );
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
        throw failureFor(verifyResults, "Some checks still failing after auto-fix");
      }
      setTelemetryStage("done");
      await outro(
        verifyResults.some((r) => r.status === "warn")
          ? "Checks complete; review remaining warnings"
          : "All checks passing",
      );
      return;
    }
  }

  const hasFailure = allResults.some((r) => r.status === "fail");
  if (hasFailure) {
    throw failureFor(allResults, "Doctor found issues with your Clerk integration");
  }
  setTelemetryStage("done");
  await outro(
    allResults.some((r) => r.status === "warn")
      ? "Checks complete; review remaining warnings"
      : "All checks passing",
  );
}

export function registerDoctor(program: Program): void {
  program
    .command("doctor")
    .description("Check your project's Clerk integration health")
    .option("--verbose", "Show detailed output for each check")
    .option("--json", "Output results as JSON")
    .option("--spotlight", "Only show warnings and failures")
    .option("--fix", "Attempt to auto-fix issues")
    .option("--project <path>", "Select an Xcode project or workspace")
    .option("--configuration <name>", "Select a custom build configuration")
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
