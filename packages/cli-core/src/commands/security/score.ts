import type { Finding, SecurityGrade, SecurityScore, Severity } from "./types.ts";

export const SEVERITY_WEIGHT: Record<Severity, number> = {
  critical: 3,
  recommended: 2,
  "good-to-have": 1,
};

const GRADE_ORDER: SecurityGrade[] = ["F", "D", "C", "B", "A"];
// A green grade must mean no critical gaps, whatever the weighted ratio says.
const CRITICAL_GRADE_CAP: SecurityGrade = "C";

function gradeForRatio(ratio: number): SecurityGrade {
  if (ratio >= 0.95) return "A";
  if (ratio >= 0.8) return "B";
  if (ratio >= 0.6) return "C";
  if (ratio >= 0.4) return "D";
  return "F";
}

// Blocked counts as a gap; not-applicable never reaches this list.
export function computeScore(findings: Finding[]): SecurityScore {
  const totalWeight = findings.reduce((sum, f) => sum + SEVERITY_WEIGHT[f.severity], 0);
  const metWeight = findings.reduce(
    (sum, f) => sum + (f.status === "met" ? SEVERITY_WEIGHT[f.severity] : 0),
    0,
  );
  const ratio = totalWeight === 0 ? 1 : metWeight / totalWeight;
  const hasCriticalGap = findings.some((f) => f.severity === "critical" && f.status !== "met");

  let grade = gradeForRatio(ratio);
  if (hasCriticalGap && GRADE_ORDER.indexOf(grade) > GRADE_ORDER.indexOf(CRITICAL_GRADE_CAP)) {
    grade = CRITICAL_GRADE_CAP;
  }

  return {
    grade,
    percent: Math.round(ratio * 100),
    met: findings.filter((f) => f.status === "met").length,
    total: findings.length,
    hasCriticalGap,
  };
}
