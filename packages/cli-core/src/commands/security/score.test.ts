import { test, expect, describe } from "bun:test";
import { computeScore } from "./score.ts";
import type { Finding, FindingStatus, SecurityGrade, Severity } from "./types.ts";

function finding(severity: Severity, status: FindingStatus): Finding {
  return {
    id: `${severity}-${status}`,
    title: "",
    description: "",
    severity,
    status,
    path: "",
    met: status === "met",
    currentValue: null,
    recommendedValue: null,
    current: "",
    recommended: "",
    patch: null,
    suggestedPatch: null,
    remedy: "",
    docsUrl: "",
    dashboardUrl: "",
  };
}

describe("computeScore", () => {
  test("all met is an A", () => {
    const score = computeScore([finding("critical", "met"), finding("good-to-have", "met")]);
    expect(score).toEqual({ grade: "A", percent: 100, met: 2, total: 2, hasCriticalGap: false });
  });

  test("an empty list scores 100", () => {
    expect(computeScore([]).percent).toBe(100);
  });

  test("weights severities 3 / 2 / 1", () => {
    const score = computeScore([
      finding("critical", "met"),
      finding("recommended", "unmet"),
      finding("good-to-have", "unmet"),
    ]);
    expect(score.percent).toBe(50);
  });

  const THRESHOLDS: Array<[number, SecurityGrade]> = [
    [0.95, "A"],
    [0.8, "B"],
    [0.6, "C"],
    [0.4, "D"],
    [0.39, "F"],
  ];

  test.each(THRESHOLDS)("ratio %d grades %s", (ratio, grade) => {
    const total = 100;
    const met = Math.round(ratio * total);
    const findings = Array.from({ length: total }, (_, i) =>
      finding("good-to-have", i < met ? "met" : "unmet"),
    );
    expect(computeScore(findings).grade).toBe(grade);
  });

  test("an unmet critical caps the grade at C", () => {
    const findings = [
      finding("critical", "unmet"),
      ...Array.from({ length: 30 }, () => finding("good-to-have", "met")),
    ];
    const score = computeScore(findings);
    expect(score.percent).toBeGreaterThanOrEqual(90);
    expect(score.grade).toBe("C");
    expect(score.hasCriticalGap).toBe(true);
  });

  test("the cap does not raise a lower grade", () => {
    const score = computeScore([finding("critical", "unmet"), finding("critical", "unmet")]);
    expect(score.grade).toBe("F");
  });

  test("blocked findings count as gaps", () => {
    const score = computeScore([finding("recommended", "blocked"), finding("recommended", "met")]);
    expect(score.percent).toBe(50);
    expect(score.met).toBe(1);
  });
});
