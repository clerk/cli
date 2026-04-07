import type { Root } from "../../lib/deps.ts";
import { bold, green, red } from "../../lib/color.ts";
import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { createDoctorContext } from "./helpers/context.ts";
import {
  checkLoggedIn,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
  checkEnvVars,
  checkConfigFile,
  checkShellCompletion,
  checkCliVersion,
  errorMessage,
} from "./checks.ts";
import { formatCheckResult, formatJson } from "./format.ts";
import type { CheckFn, CheckResult, DoctorContext, DoctorOptions } from "./types.ts";

const CHECKS: CheckFn[] = [
  checkCliVersion,
  checkLoggedIn,
  checkTokenValid,
  checkProjectLinked,
  checkLinkedAppExists,
  checkInstances,
  checkEnvVars,
  checkConfigFile,
  checkShellCompletion,
];

async function runChecks(
  root: Root,
  ctx: DoctorContext,
  options: DoctorOptions,
): Promise<CheckResult[]> {
  const results = await Promise.all(
    CHECKS.map(async (check) => {
      try {
        return await check(root, ctx);
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
        root.log.info(formatCheckResult(result, options.verbose ?? false));
      }
    }
    root.log.info("");
  }

  return results;
}

/**
 * `clerk doctor` accepts the full `Root` because its fix handlers are dynamic
 * (selected at runtime based on which check failed). Each fix dispatches to a
 * different ported command (login, link, env pull) with that command's own
 * slice, so a narrow up-front slice cannot cover the cross-command call
 * surface. The check helpers themselves still take a narrow `CheckDeps` slice.
 */
export async function doctor(root: Root, options: DoctorOptions = {}): Promise<void> {
  if (!options.json) {
    root.spinner.intro("clerk doctor");
  }

  const ctx = createDoctorContext(root);
  const allResults = await root.spinner.withSpinner("Running diagnostics...", () =>
    runChecks(root, ctx, options),
  );

  if (options.json) {
    const output = options.spotlight ? allResults.filter((r) => r.status !== "pass") : allResults;
    root.log.data(formatJson(output));
  }

  if (options.fix && !options.json && root.mode.isHuman()) {
    const fixable = allResults.filter((r) => r.status !== "pass" && r.fix);

    const seen = new Set<string>();
    const uniqueFixable = fixable.filter((r) => {
      const label = r.fix?.label;
      if (!label || seen.has(label)) return false;
      seen.add(label);
      return true;
    });

    if (uniqueFixable.length > 0) {
      root.log.info("");
      root.log.info(bold("Auto-fix"));
      root.log.info("");

      for (const result of uniqueFixable) {
        const fix = result.fix;
        if (!fix) continue;
        const proceed = await root.prompts.confirm({
          message: `Fix "${result.name}"? (${fix.label})`,
          default: true,
        });

        if (proceed) {
          try {
            await fix.run(root);
            root.log.success(`  ${green("\u2713")} ${result.name} fixed`);
          } catch (error) {
            root.log.error(`  ${red("\u2717")} Fix failed: ${errorMessage(error)}`);
          }
        }
      }

      root.spinner.bar();

      const verifyCtx = createDoctorContext(root);
      const verifyResults = await root.spinner.withSpinner("Verifying fixes...", () =>
        runChecks(root, verifyCtx, {
          ...options,
          fix: false,
          spotlight: false,
        }),
      );

      const hasVerifyFailure = verifyResults.some((r) => r.status === "fail");
      if (hasVerifyFailure) {
        throw new CliError("Some checks still failing after auto-fix", {
          code: ERROR_CODE.DOCTOR_FAILED,
        });
      }
      root.spinner.outro("All checks passing");
      return;
    }
  }

  const hasFailure = allResults.some((r) => r.status === "fail");
  if (hasFailure) {
    throw new CliError("Doctor found issues with your Clerk integration", {
      code: ERROR_CODE.DOCTOR_FAILED,
    });
  }
  root.spinner.outro("All checks passing");
}
