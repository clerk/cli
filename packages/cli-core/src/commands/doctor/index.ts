import type { Program } from "../../cli-program.ts";
import { isAgent, isHuman } from "../../mode.ts";
import { bold, green, red } from "../../lib/color.ts";
import { log } from "../../lib/log.ts";
import { CliError, ERROR_CODE, errorMessage } from "../../lib/errors.ts";
import { intro, outro, bar, withSpinner } from "../../lib/spinner.ts";
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
function getChecks(): { name: string; run: CheckFn }[] {
  return (Object.keys(CHECKS) as CheckKey[])
    .filter((key) => key !== "hostExecution" || isAgent())
    .map((key) => ({ name: CHECK_NAME[key], run: CHECKS[key] }));
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
 *
 * Decided from one result set. After `--fix`, that is the verify pass alone:
 * it re-runs every check, so it is the complete answer and the screen the
 * user last saw. The cost is that a first-pass crash the verify pass does not
 * reproduce is recorded nowhere — a transient one is superseded by whatever
 * durable finding remained, which is why `doctor_check_crashed` rows can be
 * rarer than crashes people report.
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
