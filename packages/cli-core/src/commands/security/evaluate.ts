import { agentDocsUrl } from "../../lib/errors.ts";
import { isAgent } from "../../mode.ts";
import { buildDashboardUrl } from "../open/index.ts";
import { CHECKS } from "./catalog.ts";
import { computeScore } from "./score.ts";
import type {
  AuditReport,
  CheckDef,
  CheckInput,
  Finding,
  FindingStatus,
  InstanceRef,
  Severity,
} from "./types.ts";

export const SEVERITY_ORDER: Severity[] = ["critical", "recommended", "good-to-have"];
const STATUS_RANK: Record<FindingStatus, number> = { unmet: 0, blocked: 1, met: 2 };

export function targetFlags(ref: InstanceRef): string {
  return ` --app ${ref.appId} --instance ${ref.instanceId}`;
}

export function fixCommandFor(ids: string[], ref: InstanceRef): string {
  return `clerk security fix ${ids.join(" ")}${targetFlags(ref)}${isAgent() ? " --yes" : ""}`;
}

export function fixCommandWithDecision(
  check: CheckDef,
  values: string[],
  ref: InstanceRef,
): string {
  const flag = check.decision ? ` --${check.decision.flag} ${values.join(",")}` : "";
  return `clerk security fix ${check.id}${flag}${targetFlags(ref)}${isAgent() ? " --yes" : ""}`;
}

export function remedyFor(
  check: CheckDef,
  status: FindingStatus,
  ref: InstanceRef,
  input: CheckInput,
  blockedByTitle?: string,
): string {
  if (status === "met") return "Nothing to do.";
  if (status === "blocked")
    return `Make "${blockedByTitle}" available first (\`${check.blockedBy}\`), or fix both together: \`${fixCommandFor([check.blockedBy!, check.id], ref)}\`.`;
  if (check.patch) return `Run \`${fixCommandFor([check.id], ref)}\`.`;
  if (check.decision) {
    const values = check.decision.defaults(input);
    return `Run \`${fixCommandWithDecision(check, values, ref)}\` (or pick other ${check.decision.options.map((o) => o.value).join(", ")}).`;
  }
  return check.manualRemedy ?? "Configure this in the Clerk Dashboard.";
}

export function evaluate(input: CheckInput, ref: InstanceRef): Finding[] {
  const applicable = CHECKS.filter((check) => check.appliesTo?.(input) ?? true);
  const evaluations = new Map(applicable.map((check) => [check.id, check.evaluate(input)]));

  const findings = applicable.map((check): Finding => {
    const evaluation = evaluations.get(check.id)!;
    const prerequisite = check.blockedBy ? evaluations.get(check.blockedBy) : undefined;
    const status: FindingStatus = evaluation.met
      ? "met"
      : prerequisite && !prerequisite.met
        ? "blocked"
        : "unmet";
    const blockedByTitle = CHECKS.find((c) => c.id === check.blockedBy)?.title;
    const patch = status === "unmet" && check.patch ? check.patch(input) : null;
    const decision = status === "unmet" && !check.patch ? check.decision : undefined;
    const suggested = decision?.defaults(input) ?? [];
    const suggestedPatch = decision ? decision.patch(suggested, input) : null;
    return {
      id: check.id,
      title: check.title,
      description: check.description,
      severity: check.severity,
      status,
      path: check.path,
      ...evaluation,
      ...(check.feature && { feature: check.feature }),
      ...(check.blockedBy && { blockedBy: check.blockedBy }),
      patch,
      suggestedPatch,
      ...(decision && {
        decision: {
          flag: decision.flag,
          multiple: decision.multiple,
          options: decision.options.map((o) => o.value),
          suggested,
        },
      }),
      remedy: remedyFor(check, status, ref, input, blockedByTitle),
      docsUrl: agentDocsUrl(check.docsUrl),
      dashboardUrl: buildDashboardUrl(ref.appId, ref.instanceId, check.dashboardPath),
    };
  });

  return sortFindings(findings);
}

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity) ||
      STATUS_RANK[a.status] - STATUS_RANK[b.status],
  );
}

export function fixableIds(findings: Finding[], goodToHave = true): string[] {
  return findings
    .filter((f) => f.status === "unmet" && f.patch && (goodToHave || f.severity !== "good-to-have"))
    .map((f) => f.id);
}

export function buildReport(input: CheckInput, ref: InstanceRef): AuditReport {
  const findings = evaluate(input, ref);
  // Good-to-have is opt-in.
  const fixable = fixableIds(findings, false);
  return {
    instance: ref,
    score: computeScore(findings),
    fixCommand: fixable.length ? fixCommandFor(fixable, ref) : null,
    findings,
  };
}
