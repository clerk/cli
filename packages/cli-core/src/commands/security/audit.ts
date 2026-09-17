import { log } from "../../lib/log.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { intro, outro } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { formatReportHuman, formatReportJson } from "./format.ts";
import { loadAudit } from "./load.ts";
import type { AuditOptions } from "./types.ts";

export async function securityAudit(options: AuditOptions = {}): Promise<void> {
  const json = Boolean(options.json) || isAgent();

  if (!json) intro("Security audit");
  const { report } = await loadAudit(options);

  if (json) {
    log.data(formatReportJson(report));
    return;
  }

  log.blank();
  for (const line of formatReportHuman(report)) log.info(line);

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
