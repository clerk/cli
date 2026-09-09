import { bold, cyan, dim, green, red, yellow } from "../../lib/color.ts";
import { SEVERITY_ORDER } from "./evaluate.ts";
import type {
  AuditReport,
  CheckDef,
  Finding,
  FindingStatus,
  SecurityScore,
  Severity,
} from "./types.ts";

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "Critical",
  recommended: "Recommended",
  "good-to-have": "Good to have",
};

const STATUS_ICON: Record<FindingStatus, string> = {
  met: green("✓"),
  blocked: yellow("!"),
  unmet: red("✗"),
};

const GRADE_COLOR: Record<SecurityScore["grade"], (s: string) => string> = {
  A: green,
  B: green,
  C: yellow,
  D: red,
  F: red,
};

export function formatReportJson(report: AuditReport, spotlight: boolean): string {
  const findings = spotlight ? report.findings.filter((f) => f.status !== "met") : report.findings;
  return JSON.stringify({ ...report, findings }, null, 2);
}

export function formatScoreTransition(
  before: SecurityScore,
  after: SecurityScore,
  dryRun: boolean,
): string {
  const to = GRADE_COLOR[after.grade](bold(after.grade));
  const grade =
    before.grade === after.grade
      ? `Grade ${to}`
      : `Grade ${GRADE_COLOR[before.grade](before.grade)} ${dim("→")} ${to}`;
  const prefix = dryRun ? dim("[dry-run] projected ") : "";
  return `${prefix}${grade}${dim(" · ")}${after.met} of ${after.total} recommendations met`;
}

function formatScoreLine(score: SecurityScore): string {
  const grade = GRADE_COLOR[score.grade](bold(`Grade ${score.grade}`));
  const parts = [grade, `${score.percent}%`, `${score.met} of ${score.total} recommendations met`];
  if (score.hasCriticalGap) parts.push(red("critical gaps present"));
  return parts.join(dim(" · "));
}

function formatFindingLine(finding: Finding, widths: { title: number; id: number }): string {
  const title = finding.title.padEnd(widths.title);
  const id = finding.id.padEnd(widths.id);
  if (finding.status === "met") return `${STATUS_ICON.met} ${dim(title)}  ${dim(id)}`;
  if (finding.status === "blocked") {
    return `${STATUS_ICON.blocked} ${title}  ${cyan(id)}  ${dim(`blocked: ${finding.remedy}`)}`;
  }
  const change = `${finding.current} ${dim("→")} ${finding.recommended}`;
  const manual = finding.patch
    ? ""
    : finding.decision
      ? dim(`  (asks --${finding.decision.flag})`)
      : dim("  (manual)");
  return `${STATUS_ICON.unmet} ${title}  ${cyan(id)}  ${change}${manual}`;
}

export function formatReportHuman(report: AuditReport, spotlight: boolean): string[] {
  const findings = spotlight ? report.findings.filter((f) => f.status !== "met") : report.findings;
  const widths = {
    title: Math.max(0, ...findings.map((f) => f.title.length)),
    id: Math.max(0, ...findings.map((f) => f.id.length)),
  };
  const lines = [formatScoreLine(report.score), ""];

  for (const severity of SEVERITY_ORDER) {
    const group = findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push(bold(SEVERITY_LABEL[severity]));
    for (const finding of group) lines.push(formatFindingLine(finding, widths));
    lines.push("");
  }

  if (findings.length === 0) lines.push(green("Every recommendation is met."), "");
  return lines;
}

export function formatCatalogJson(checks: CheckDef[]): string {
  return JSON.stringify(
    checks.map((check) => ({
      id: check.id,
      title: check.title,
      description: check.description,
      severity: check.severity,
      path: check.path,
      fixable: Boolean(check.patch),
      ...(check.decision && {
        decision: {
          flag: check.decision.flag,
          multiple: check.decision.multiple,
          options: check.decision.options.map((o) => o.value),
        },
      }),
      ...(check.feature && { feature: check.feature }),
      ...(check.blockedBy && { blockedBy: check.blockedBy }),
      docsUrl: check.docsUrl,
    })),
    null,
    2,
  );
}

export function formatCatalogHuman(checks: CheckDef[]): string[] {
  const width = Math.max(...checks.map((c) => c.id.length));
  const lines: string[] = [];
  for (const severity of SEVERITY_ORDER) {
    lines.push(bold(SEVERITY_LABEL[severity]));
    for (const check of checks.filter((c) => c.severity === severity)) {
      const fix = check.patch
        ? ""
        : check.decision
          ? dim(`  (asks --${check.decision.flag})`)
          : dim("  (manual)");
      lines.push(`  ${cyan(check.id.padEnd(width))}  ${check.title}${fix}`);
    }
    lines.push("");
  }
  return lines;
}
