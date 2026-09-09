import { CliError, ERROR_CODE } from "../../lib/errors.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { formatReportHuman, formatReportJson } from "./format.ts";
import { loadAudit } from "./load.ts";
import type { AuditOptions, FailOnLevel, Finding, Severity } from "./types.ts";

const FAIL_ON_SEVERITIES: Record<FailOnLevel, Severity[]> = {
  critical: ["critical"],
  recommended: ["critical", "recommended"],
  any: ["critical", "recommended", "good-to-have"],
  none: [],
};

export function failingFindings(findings: Finding[], failOn: FailOnLevel): Finding[] {
  const severities = FAIL_ON_SEVERITIES[failOn];
  return findings.filter((f) => f.status !== "met" && severities.includes(f.severity));
}

export async function securityAudit(options: AuditOptions = {}): Promise<void> {
  const json = Boolean(options.json) || isAgent();
  const spotlight = Boolean(options.spotlight);
  const failOn = options.failOn ?? "critical";

  if (!json) intro("Security audit");
  const { report } = await loadAudit(options);

  if (json) {
    log.data(formatReportJson(report, spotlight));
  } else {
    log.blank();
    for (const line of formatReportHuman(report, spotlight)) log.info(line);
  }

  const failing = failingFindings(report.findings, failOn);
  if (failing.length > 0) {
    const noun = failing.length === 1 ? "recommendation" : "recommendations";
    throw new CliError(`${failing.length} security ${noun} unmet (--fail-on ${failOn})`, {
      code: ERROR_CODE.SECURITY_AUDIT_FAILED,
    });
  }

  if (!json) {
    const flags = `${options.app ? ` --app ${options.app}` : ""}${options.instance ? ` --instance ${options.instance}` : ""}`;
    await outro(
      report.fixCommand
        ? [
            `Run \`clerk security fix${flags}\` to choose which recommendations to apply, or \`clerk security fix --all${flags}\` for every critical and recommended one`,
            ...NEXT_STEPS.SECURITY_AUDIT,
          ]
        : NEXT_STEPS.SECURITY_AUDIT,
    );
  }
}
