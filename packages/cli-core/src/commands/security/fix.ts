import { throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import type { Example } from "../../lib/help.ts";
import { log } from "../../lib/log.ts";
import { NEXT_STEPS } from "../../lib/next-steps.ts";
import { isRecord } from "../../lib/objects.ts";
import { withGutter } from "../../lib/spinner.ts";
import { isAgent } from "../../mode.ts";
import { applyConfigPatch } from "../config/apply-patch.ts";
import { CHECKS, CHECK_IDS, findCheck } from "./catalog.ts";
import { evaluate, fixCommandFor, fixCommandWithDecision, fixableIds } from "./evaluate.ts";
import { formatScoreTransition } from "./format.ts";
import { loadAudit } from "./load.ts";
import { deepMerge, projectPatches } from "./merge.ts";
import { computeScore } from "./score.ts";
import type {
  CheckDef,
  CheckInput,
  Finding,
  FixOptions,
  FixSummary,
  InstanceConfig,
  InstanceRef,
  SkipReason,
} from "./types.ts";

const EXAMPLES: Example[] = [
  { command: "clerk security fix user-lockout client-trust --yes", description: "Apply two fixes" },
  {
    command: "clerk security fix mfa --factors authenticator,backup-code --yes",
    description: "Enable two-factor authentication",
  },
  { command: "clerk security fix --all --yes", description: "Apply every fixable recommendation" },
];

const SKIP_REASON_TEXT: Record<SkipReason, string> = {
  met: "already met",
  not_applicable: "not applicable to this instance",
};

interface Selection {
  checks: CheckDef[];
  skipped: FixSummary["skipped"];
}

function suppliedDecisions(options: FixOptions): Partial<Record<"factors" | "strategy", string[]>> {
  const factors = options.factors
    ?.flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  return {
    ...(factors?.length && { factors }),
    ...(options.strategy && { strategy: [options.strategy] }),
  };
}

function selectByIds(ids: string[], findings: Finding[], ref: InstanceRef): Selection {
  const byId = new Map(findings.map((f) => [f.id, f]));
  const problems: string[] = [];
  const selection: Selection = { checks: [], skipped: [] };
  for (const id of ids) {
    const finding = byId.get(id);
    const check = findCheck(id)!;
    if (!finding) {
      selection.skipped.push({ id, reason: "not_applicable" });
    } else if (finding.status === "met") {
      selection.skipped.push({ id, reason: "met" });
    } else if (finding.status === "blocked" && !ids.includes(finding.blockedBy!)) {
      // Allowed when the prerequisite is fixed in the same call.
      problems.push(`${id}: ${finding.remedy}`);
    } else if (!check.patch && !check.decision) {
      problems.push(`${id}: ${finding.remedy}`);
    } else {
      selection.checks.push(check);
    }
  }

  if (problems.length > 0) {
    const fixable = selection.checks.filter((c) => c.patch).map((c) => c.id);
    const examples: Example[] = fixable.length
      ? [
          {
            command: fixCommandFor(fixable, ref),
            description: "Apply the fixable recommendations from this selection",
          },
          ...EXAMPLES,
        ]
      : EXAMPLES;
    throwUsageError(
      `${problems.length === 1 ? "This recommendation needs" : "These recommendations need"} a manual change:\n  ${problems.join("\n  ")}`,
      undefined,
      undefined,
      examples,
    );
  }
  return selection;
}

function selectAll(
  findings: Finding[],
  supplied: ReturnType<typeof suppliedDecisions>,
  goodToHave: boolean,
): Selection {
  const ids = new Set(fixableIds(findings, goodToHave));
  for (const f of findings) {
    if (f.status === "unmet" && f.decision && supplied[f.decision.flag]) ids.add(f.id);
  }
  for (const f of findings) {
    if (f.status === "blocked" && f.blockedBy && ids.has(f.blockedBy) && findCheck(f.id)?.patch) {
      ids.add(f.id);
    }
  }
  return { checks: [...ids].map((id) => findCheck(id)!), skipped: [] };
}

async function selectInteractively(findings: Finding[]): Promise<Selection> {
  const candidates = findings.filter((f) => f.status === "unmet" && (f.patch || f.decision));
  if (candidates.length === 0) return { checks: [], skipped: [] };

  const { multiselect } = await import("../../lib/prompts.ts");
  const chosen = await multiselect<string>({
    message: "Which recommendations should be applied?",
    options: candidates.map((f) => ({
      value: f.id,
      label: f.title,
      hint: f.decision
        ? `${f.id} · asks which ${f.decision.flag}`
        : `${f.id} · ${f.current} → ${f.recommended}`,
    })),
    // Good-to-have offered but unticked.
    initialValues: candidates
      .filter((f) => f.patch && f.severity !== "good-to-have")
      .map((f) => f.id),
    required: false,
  });
  if (chosen.length === 0) throwUserAbort();
  const ids = new Set(chosen);
  for (const f of findings) {
    if (f.status === "blocked" && f.blockedBy && ids.has(f.blockedBy) && findCheck(f.id)?.patch) {
      ids.add(f.id);
    }
  }
  return { checks: [...ids].map((id) => findCheck(id)!), skipped: [] };
}

async function resolveDecision(
  check: CheckDef,
  supplied: ReturnType<typeof suppliedDecisions>,
  input: CheckInput,
  ref: InstanceRef,
): Promise<string[]> {
  const decision = check.decision!;
  const valid = decision.options.map((o) => o.value);
  const given = supplied[decision.flag];
  if (given) {
    const bad = given.filter((v) => !valid.includes(v));
    if (bad.length > 0) {
      throwUsageError(
        `Unknown --${decision.flag} value${bad.length === 1 ? "" : "s"} for ${check.id}: ${bad.join(", ")}. Choose from ${valid.join(", ")}.`,
      );
    }
    if (!decision.multiple && given.length > 1) {
      throwUsageError(`--${decision.flag} takes a single value for ${check.id}.`);
    }
    return given;
  }

  const defaults = decision.defaults(input);
  if (isAgent()) {
    throwUsageError(
      `${check.id} needs --${decision.flag} (${valid.join(", ")}).`,
      undefined,
      undefined,
      [
        {
          command: fixCommandWithDecision(check, defaults, ref),
          description: `Apply ${check.id} with the suggested ${decision.flag}`,
        },
      ],
    );
  }

  if (decision.multiple) {
    const { multiselect } = await import("../../lib/prompts.ts");
    const values = await multiselect<string>({
      message: decision.prompt,
      options: decision.options,
      initialValues: defaults,
      required: true,
    });
    if (values.length === 0) throwUserAbort();
    return values;
  }
  const { select } = await import("../../lib/listage.ts");
  const value = await select<string>({
    message: decision.prompt,
    choices: decision.options.map((o) => ({ value: o.value, name: o.label })),
    default: defaults[0],
  });
  return [value];
}

// A dry-run answers `{dry_run, before, after}` and a write may echo only touched
// sections, so the server's view is layered over the fetched document.
function afterDocument(
  body: InstanceConfig | undefined,
  before: InstanceConfig,
  projected: InstanceConfig,
): InstanceConfig {
  if (!isRecord(body)) return projected;
  const view = body.dry_run === true && isRecord(body.after) ? body.after : body;
  const sections = Object.fromEntries(
    Object.entries(view).filter(([key]) => key in before && key !== "config_version"),
  );
  return Object.keys(sections).length ? deepMerge(before, sections) : projected;
}

export async function securityFix(ids: string[] = [], options: FixOptions = {}): Promise<void> {
  const selected = [...new Set([...ids, ...(options.check ?? [])])];
  const all = Boolean(options.all);
  const json = Boolean(options.json) || isAgent();
  const supplied = suppliedDecisions(options);

  if (selected.length > 0 && all) {
    throwUsageError("Pass either check ids or --all, not both.", undefined, undefined, EXAMPLES);
  }
  const unknown = selected.filter((id) => !CHECK_IDS.includes(id));
  if (unknown.length > 0) {
    throwUsageError(
      `Unknown ${unknown.length === 1 ? "check" : "checks"}: ${unknown.join(", ")}.\nValid ids: ${CHECK_IDS.join(", ")}.`,
      undefined,
      undefined,
      EXAMPLES,
    );
  }
  if (isAgent()) {
    if (selected.length === 0 && !all) {
      throwUsageError(
        "Pass one or more check ids, or --all. Run `clerk security checks` to list them.",
        undefined,
        undefined,
        EXAMPLES,
      );
    }
    if (!options.yes && !options.dryRun) {
      throwUsageError(
        "Pass --yes to apply security fixes in agent mode.",
        undefined,
        undefined,
        EXAMPLES,
      );
    }
  }

  await withGutter("Applying security fixes", async ({ setNextSteps }) => {
    const { target, input, report } = await loadAudit(options);
    const { checks, skipped } = all
      ? selectAll(report.findings, supplied, Boolean(options.goodToHave))
      : selected.length > 0
        ? selectByIds(selected, report.findings, report.instance)
        : await selectInteractively(report.findings);
    for (const { id, reason } of skipped)
      log.info(`Skipping \`${id}\`: ${SKIP_REASON_TEXT[reason]}`);

    const dryRun = Boolean(options.dryRun);
    const summary: FixSummary = {
      changed: false,
      dryRun,
      applied: [],
      decisions: {},
      skipped,
      score: { before: report.score, after: report.score },
      remaining: report.findings.filter((f) => f.status !== "met").map((f) => f.id),
    };

    if (checks.length === 0) {
      log.info("Nothing to fix.");
      if (json) log.data(JSON.stringify(summary, null, 2));
      return;
    }

    // Catalog order: prerequisites first.
    const ordered = [...checks].sort((a, b) => CHECKS.indexOf(a) - CHECKS.indexOf(b));
    const resolved: CheckDef[] = [];
    for (const check of ordered) {
      if (check.patch || !check.decision) {
        resolved.push(check);
        continue;
      }
      const values = await resolveDecision(check, supplied, input, report.instance);
      const problem = check.decision.validate?.(values, input);
      if (problem) throwUsageError(problem);
      summary.decisions[check.id] = values;
      resolved.push({ ...check, patch: (i) => check.decision!.patch(values, i) });
    }

    const applied = resolved.map((c) => c.id);
    const { payload, projected } = projectPatches(input, resolved);
    let written: InstanceConfig | undefined;
    const changed = await applyConfigPatch({
      target,
      payload,
      verb: `Applying ${applied.length === 1 ? "1 security fix" : `${applied.length} security fixes`}`,
      successMessage: `Applied: ${applied.join(", ")}`,
      failureContext: "Failed to apply security fixes",
      yes: options.yes,
      dryRun,
      currentConfig: input.config,
      onWritten: (body) => {
        written = body;
      },
    });

    if (changed) {
      const after = evaluate(
        { ...input, config: afterDocument(written, input.config, projected) },
        report.instance,
      );
      summary.changed = true;
      summary.applied = applied;
      summary.score.after = computeScore(after);
      summary.remaining = after.filter((f) => f.status !== "met").map((f) => f.id);
      log.info(formatScoreTransition(summary.score.before, summary.score.after, dryRun));
    }

    if (json) {
      log.data(JSON.stringify(summary, null, 2));
    } else if (changed && !dryRun && summary.remaining.length > 0) {
      setNextSteps(NEXT_STEPS.SECURITY_FIX_REMAINING);
    }
  });
}
