import type { Program } from "../../cli-program.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { bold, green, red } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../lib/errors.ts";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.ts";
import { createDoctorContext } from "./context.ts";
import {
  CHECK_NAME,
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
import type { CheckFn, CheckResult, DoctorContext, DoctorOptions } from "./types.ts";

/**
 * A check paired with the name to report it under if it throws. The name it
 * gives its own results comes from the same {@link CHECK_NAME} entry, so the
 * two cannot disagree.
 */
type RegisteredCheck = { name: string; run: CheckFn };

const BASE_CHECKS: RegisteredCheck[] = [
  { name: CHECK_NAME.cliVersion, run: checkCliVersion },
  { name: CHECK_NAME.loggedIn, run: checkLoggedIn },
  { name: CHECK_NAME.tokenValid, run: checkTokenValid },
  { name: CHECK_NAME.projectLinked, run: checkProjectLinked },
  { name: CHECK_NAME.linkedAppExists, run: checkLinkedAppExists },
  { name: CHECK_NAME.instances, run: checkInstances },
  { name: CHECK_NAME.envVars, run: checkEnvVars },
  { name: CHECK_NAME.configFile, run: checkConfigFile },
  { name: CHECK_NAME.shellCompletion, run: checkShellCompletion },
  { name: CHECK_NAME.mcp, run: checkMcp },
];

function getChecks(): RegisteredCheck[] {
  return isAgent()
    ? [{ name: CHECK_NAME.hostExecution, run: checkHostExecution }, ...BASE_CHECKS]
    : BASE_CHECKS;
}

/**
 * A crash is a bug in the CLI, not a finding about the user's project, so it
 * says which check broke instead of reporting an anonymous failure the person
 * cannot act on. It still counts as a failing result: the check was asked a
 * question and has no answer, and treating that as a pass would hide the one
 * case where doctor itself is broken.
 */
async function runChecks(ctx: DoctorContext): Promise<CheckResult[]> {
  return Promise.all(
    getChecks().map(async ({ name, run }) => {
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
}

/**
 * What to throw for a set of results that includes a failure. A crashed check
 * and a real finding are both exit 1, but they send the reader to different
 * places — one is a CLI bug, the other is the user's integration — and a
 * single code left them indistinguishable in telemetry and on screen.
 */
function failureCodeFor(
  results: CheckResult[],
): typeof ERROR_CODE.DOCTOR_CHECK_CRASHED | typeof ERROR_CODE.DOCTOR_FAILED {
  return results.some((r) => r.crashed)
    ? ERROR_CODE.DOCTOR_CHECK_CRASHED
    : ERROR_CODE.DOCTOR_FAILED;
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
  const allResults = await withSpinner("Running diagnostics...", async () => runChecks(ctx));

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
        runChecks(verifyCtx),
      );
      printResults(verifyResults, { ...options, fix: false, spotlight: false });

      const hasVerifyFailure = verifyResults.some((r) => r.status === "fail");
      if (hasVerifyFailure) {
        throw new CliError("Some checks still failing after auto-fix", {
          code: failureCodeFor(verifyResults),
        });
      }
      await outro("All checks passing");
      return;
    }
  }

  const hasFailure = allResults.some((r) => r.status === "fail");
  if (hasFailure) {
    throw new CliError("Doctor found issues with your Clerk integration", {
      code: failureCodeFor(allResults),
    });
  }
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
    .setExamples([
      { command: "clerk doctor", description: "Run all health checks" },
      { command: "clerk doctor --verbose", description: "Show detailed output for each check" },
      { command: "clerk doctor --json", description: "Output results as machine-readable JSON" },
      { command: "clerk doctor --fix", description: "Auto-fix detected issues" },
      { command: "clerk doctor --spotlight", description: "Only show warnings and failures" },
    ])
    .action(doctor);
}
