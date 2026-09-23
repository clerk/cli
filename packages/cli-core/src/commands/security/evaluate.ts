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

/** `clerk security fix <ids> [--factors …] [--strategy …] --app … --instance … [--yes]`. */
export function fixCommand(
  ids: string[],
  ref: InstanceRef,
  decisions: Record<string, string[]> = {},
): string {
  const flags = ids
    .map((id) => {
      const decision = CHECKS.find((c) => c.id === id)?.decision;
      const values = decisions[id];
      return decision && values ? ` --${decision.flag} ${values.join(",")}` : "";
    })
    .join("");
  return `clerk security fix ${ids.join(" ")}${flags}${targetFlags(ref)}${isAgent() ? " --yes" : ""}`;
}

function remedyFor(
  check: CheckDef,
  status: FindingStatus,
  ref: InstanceRef,
  input: CheckInput,
  blockedByTitle?: string,
): string {
  if (status === "met") return "Nothing to do.";
  if (status === "blocked")
    return `Make "${blockedByTitle}" available first (\`${check.blockedBy}\`), or fix both together: \`${fixCommand([check.blockedBy!, check.id], ref)}\`.`;
  if (check.patch) return `Run \`${fixCommand([check.id], ref)}\`.`;
  if (check.decision) {
    const values = check.decision.defaults(input);
    return `Run \`${fixCommand([check.id], ref, { [check.id]: values })}\` (or pick other ${check.decision.options.map((o) => o.value).join(", ")}).`;
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
    return {
      id: check.id,
      title: check.title,
      description: check.description,
      severity: check.severity,
      status,
      path: check.path,
      ...evaluation,
      ...(check.features && { features: check.features }),
      ...(check.blockedBy && { blockedBy: check.blockedBy }),
      ...(check.customFlows && status !== "met" && { customFlows: check.customFlows }),
      patch,
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

function sortFindings(findings: Finding[]): Finding[] {
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
    fixCommand: fixable.length ? fixCommand(fixable, ref) : null,
    findings,
  };
}
