import { isHuman } from "../../mode.ts";
import { bold, green, red } from "../../lib/color.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { createDoctorContext } from "./context.ts";
import {
  checkLoggedIn,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
  checkEnvVars,
  checkConfigFile,
  checkShellCompletion,
  errorMessage,
} from "./checks.ts";
import { formatCheckResult, formatJson } from "./format.ts";
import type { CheckFn, CheckResult, DoctorContext, DoctorOptions } from "./types.ts";

const CHECKS: CheckFn[] = [
  checkLoggedIn,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
  checkEnvVars,
  checkConfigFile,
  checkShellCompletion,
];

async function runChecks(ctx: DoctorContext, options: DoctorOptions): Promise<CheckResult[]> {
  const results = await Promise.all(
    CHECKS.map(async (check) => {
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

  if (!options.json) {
    for (const result of results) {
      if (!options.spotlight || result.status !== "pass") {
        console.log(formatCheckResult(result, options.verbose ?? false));
      }
    }
    console.log("");
  }

  return results;
}

export async function doctor(options: DoctorOptions = {}): Promise<void> {
  if (!options.json) {
    console.log("");
  }

  const ctx = createDoctorContext();
  const allResults = await runChecks(ctx, options);

  if (options.json) {
    const output = options.spotlight ? allResults.filter((r) => r.status !== "pass") : allResults;
    console.log(formatJson(output));
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
      console.log("");
      console.log(bold("Auto-fix"));
      console.log("");

      const { confirm } = await import("@inquirer/prompts");

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
            console.log(`  ${green("✓")} ${result.name} fixed`);
          } catch (error) {
            console.log(`  ${red("✗")} Fix failed: ${errorMessage(error)}`);
          }
        }
      }

      console.log("");
      console.log(bold("Verifying fixes..."));
      console.log("");

      const verifyCtx = createDoctorContext();
      const verifyResults = await runChecks(verifyCtx, {
        ...options,
        fix: false,
        spotlight: false,
      });

      const hasVerifyFailure = verifyResults.some((r) => r.status === "fail");
      if (hasVerifyFailure) {
        throw new CliError("Some checks still failing after auto-fix.", {
          code: ERROR_CODE.DOCTOR_FAILED,
        });
      }
      return;
    }
  }

  const hasFailure = allResults.some((r) => r.status === "fail");
  if (hasFailure) {
    throw new CliError("Doctor found issues with your Clerk integration.", {
      code: ERROR_CODE.DOCTOR_FAILED,
    });
  }
}
