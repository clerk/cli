/**
 * `clerk feedback`: a structured report about a CLI problem, sent as one
 * `CLI_FEEDBACK` event over the same telemetry path as the per-run usage
 * event. Nothing here goes through `finalizeAndSendTelemetry`: that path's
 * latch keeps a run to one `CLI_COMMAND_EXECUTED`, and this run still sends
 * its own one of those, flag names only, like any other command.
 *
 * Any telemetry opt-out blocks the send. `clerk telemetry disable` prints
 * "Nothing will be sent from this machine", and an explicit report is still
 * something sent from this machine; the fallback is the GitHub issues URL.
 * The opt-out is checked before the prompts (so nobody writes a report that
 * cannot go), again after they close (an opt-out can land while the editor
 * is open), and once more inside the shared sender at the moment of the POST.
 *
 * Every free-text field is scrubbed on the client (`lib/redact.ts`) before it
 * is capped and before anything leaves the machine. The report never attaches
 * files, environment variables, transcripts or argv: the payload is built
 * only from the fields named below plus the telemetry envelope, and it is
 * built once, so the preview a person confirms is the object that is sent.
 */

import { FEEDBACK_SEND_TIMEOUT_MS, GITHUB_ISSUES_URL } from "../../lib/constants.ts";
import { throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import type { Example } from "../../lib/help.ts";
import { select } from "../../lib/listage.ts";
import { log } from "../../lib/log.ts";
import { confirm, editor, text } from "../../lib/prompts.ts";
import { redactAndCap } from "../../lib/redact.ts";
import {
  buildTelemetryEnvelope,
  getTelemetryStatus,
  sendTelemetryEvent,
  showTelemetryNoticeOnce,
  type TelemetryEnvelope,
  type TelemetryStatus,
} from "../../lib/telemetry.ts";
import { isAgent } from "../../mode.ts";
import {
  checkFeedbackRateLimit,
  readRecentFeedbackSends,
  recordFeedbackSend,
} from "./rate-limit.ts";

export const FEEDBACK_EVENT = "CLI_FEEDBACK";

/** Same values as the MCP server's `submit_feedback` tool, so the two sources combine. */
export const FEEDBACK_OUTCOMES = ["blocked", "worked_around", "succeeded_with_friction"] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOMES)[number];

/** The MCP tool's caps, applied after scrubbing (see `redactAndCap`). */
const FIELD_CAPS = {
  goal: 2000,
  attempted: 4000,
  issue: 4000,
  error_text: 4000,
  suggestion: 2000,
} as const;

/** The shape every `ERROR_CODE` value and API error code has. */
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

const FEEDBACK_NOTICE_LAST_LINE =
  "This run sends the feedback report you asked for and one usage event for this command.";

export interface FeedbackOptions {
  goal?: string;
  attempted?: string;
  issue?: string;
  outcome?: string;
  command?: string;
  errorText?: string;
  errorCode?: string;
  suggestion?: string;
  dryRun?: boolean;
  yes?: boolean;
}

/**
 * The slice of Commander's command tree that `--command` is validated
 * against. The two underscored fields are Commander's own private state,
 * read the same way `__complete.ts` reads `_hidden`: which child runs when
 * the group is invoked bare, and whether the group runs anything itself.
 */
export type CommandTree = {
  name(): string;
  aliases(): string[];
  commands: readonly CommandTree[];
  parent: CommandTree | null;
  registeredArguments?: readonly unknown[];
  _defaultCommandName?: string | null;
  _actionHandler?: unknown;
};

export const FEEDBACK_EXAMPLES: Example[] = [
  {
    command:
      'clerk feedback --goal "pull keys" --attempted "clerk env pull" --issue "wrote .env only" --outcome worked_around',
    description: "Report a command that did something other than expected",
  },
  {
    command: "clerk feedback --input-json @report.json",
    description: "Pass long text from a file (keys: goal, attempted, issue, outcome, ...)",
  },
  {
    command: "clerk feedback --dry-run --input-json @report.json",
    description: "Show exactly what would be sent, and send no report",
  },
];

type SendFailureReason = "telemetry_disabled" | "dev_build" | "rate_limited" | "send_failed";

/** The agent-mode output contract, one JSON object on stdout, exit 0. */
export type FeedbackResult =
  | { sent: true; report_id: string }
  | { sent: false; reason: SendFailureReason; fallback: string; report_id?: string };

type ValidatedFields = {
  goal: string | undefined;
  attempted: string | undefined;
  issue: string | undefined;
  outcome: FeedbackOutcome | undefined;
  command: string | null;
  errorText: string | null;
  errorCode: string | null;
  suggestion: string | null;
};

type CompleteFields = ValidatedFields & {
  goal: string;
  attempted: string;
  issue: string;
  outcome: FeedbackOutcome;
};

type CommandResolution =
  | { path: string }
  | { path: null; reason: "unknown" }
  | { path: null; reason: "bare_group"; group: string; subcommands: string[] };

function findChild(node: CommandTree, word: string): CommandTree | undefined {
  return node.commands.find((c) => c.name() === word || c.aliases().includes(word));
}

function hasOwnArguments(node: CommandTree): boolean {
  return (node.registeredArguments?.length ?? 0) > 0;
}

function defaultChild(node: CommandTree): CommandTree | undefined {
  const name = node._defaultCommandName;
  return name ? node.commands.find((c) => c.name() === name) : undefined;
}

/**
 * Resolve `--command` to the spelling usage events record: the command whose
 * action ran (`commandPathOf` in `lib/telemetry.ts`). The input is the path
 * as typed after `clerk`, a leading `clerk` tolerated, and may be a whole
 * pasted command line: anything after the command is dropped (arguments and
 * flags are never sent). Leading global flags are not parsed.
 *
 * Walk rules, verified against the real tree: at a group, an unknown word is
 * the group's own argument if it takes one (`impersonate user_123` →
 * `impersonate`), the default child's argument if it has a default (`open
 * users` → `open dashboard`), and an error otherwise (`users lst`). A group
 * with a default child is recorded as that child (`deploy` → `deploy run`).
 * A bare group that runs nothing itself (`auth`) never appears in usage
 * events, so it is an error that names its subcommands.
 */
export function resolveCommand(tree: CommandTree, input: string): CommandResolution {
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (words[0] === "clerk") words.shift();
  let node = tree;
  const parts: string[] = [];
  for (const word of words) {
    if (word.startsWith("-")) break;
    const child = findChild(node, word);
    if (child) {
      parts.push(child.name());
      node = child;
      continue;
    }
    // Not a subcommand: an argument of something, or a typo. Under a group
    // with a default child it is that child's argument only if the child
    // takes one (`open users`); `deploy run` takes none, so `deploy statsu`
    // would fail in Commander and must not be recorded as `deploy run`.
    if (node.commands.length === 0 || hasOwnArguments(node)) break;
    const fallbackChild = defaultChild(node);
    if (fallbackChild && hasOwnArguments(fallbackChild)) break;
    return { path: null, reason: "unknown" };
  }
  if (parts.length === 0) return { path: null, reason: "unknown" };
  const fallback = defaultChild(node);
  if (fallback && !node._actionHandler) {
    parts.push(fallback.name());
    node = fallback;
  }
  if (node.commands.length > 0 && !node._actionHandler) {
    return {
      path: null,
      reason: "bare_group",
      group: parts.join(" "),
      subcommands: node.commands.map((c) => `${parts.join(" ")} ${c.name()}`),
    };
  }
  return { path: parts.join(" ") };
}

/** {@link resolveCommand} as a plain path, or null when it does not resolve. */
export function resolveCommandPath(tree: CommandTree, input: string): string | null {
  return resolveCommand(tree, input).path;
}

function rootOf(tree: CommandTree): CommandTree {
  let node = tree;
  while (node.parent) node = node.parent;
  return node;
}

function trimmedOrUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function isOutcome(value: string): value is FeedbackOutcome {
  return (FEEDBACK_OUTCOMES as readonly string[]).includes(value);
}

/**
 * Step 1 in both modes: the shape of whatever was supplied. Presence of the
 * required fields is checked afterwards, differently per mode. Validated here
 * rather than with Commander's `.choices()`, which rejects a value with plain
 * text and exit 1 before any hook runs; a usage error from the handler gets
 * the JSON envelope, exit 2 and the examples.
 */
function validateShape(options: FeedbackOptions, tree: CommandTree): ValidatedFields {
  const outcome = trimmedOrUndefined(options.outcome);
  if (outcome !== undefined && !isOutcome(outcome)) {
    throwUsageError(
      `Invalid --outcome "${outcome}". Expected one of: ${FEEDBACK_OUTCOMES.join(", ")}.`,
      undefined,
      undefined,
      FEEDBACK_EXAMPLES,
    );
  }

  const commandInput = trimmedOrUndefined(options.command);
  let command: string | null = null;
  if (commandInput !== undefined) {
    const resolved = resolveCommand(tree, commandInput);
    if (resolved.path === null) {
      const detail =
        resolved.reason === "bare_group"
          ? `"${resolved.group}" runs nothing on its own; name the subcommand: ${resolved.subcommands.join(", ")}.`
          : `Unknown --command "${commandInput}". Use the command path as you would type it after \`clerk\`, e.g. "users list".`;
      throwUsageError(detail, undefined, undefined, FEEDBACK_EXAMPLES);
    }
    command = resolved.path;
  }

  const errorCode = trimmedOrUndefined(options.errorCode) ?? null;
  if (errorCode !== null && !ERROR_CODE_PATTERN.test(errorCode)) {
    throwUsageError(
      `Invalid --error-code "${errorCode}". Expected the code from the error output: lowercase letters, digits and underscores, e.g. not_linked.`,
      undefined,
      undefined,
      FEEDBACK_EXAMPLES,
    );
  }

  return {
    goal: trimmedOrUndefined(options.goal),
    attempted: trimmedOrUndefined(options.attempted),
    issue: trimmedOrUndefined(options.issue),
    outcome,
    command,
    errorText: trimmedOrUndefined(options.errorText) ?? null,
    errorCode,
    suggestion: trimmedOrUndefined(options.suggestion) ?? null,
  };
}

const REQUIRED: Array<"goal" | "attempted" | "issue" | "outcome"> = [
  "goal",
  "attempted",
  "issue",
  "outcome",
];

function missingFields(fields: ValidatedFields): string[] {
  return REQUIRED.filter((name) => fields[name] === undefined);
}

/** Agent mode: a missing field is an input the agent can fix, so it is the usage error, never `sent: false`. */
function requireFields(fields: ValidatedFields): CompleteFields {
  const missing = missingFields(fields);
  if (missing.length > 0) {
    throwUsageError(
      `Missing required ${missing.length === 1 ? "option" : "options"}: ${missing.map((name) => `--${name}`).join(", ")}.`,
      undefined,
      undefined,
      FEEDBACK_EXAMPLES,
    );
  }
  return fields as CompleteFields;
}

const nonEmpty = (value: string | undefined): string | undefined =>
  value?.trim() ? undefined : "This field is required.";

/** Human mode: ask for whatever was not passed as a flag. `--command` and `--error-code` are flags only. */
async function promptMissingFields(fields: ValidatedFields): Promise<CompleteFields> {
  const goal =
    fields.goal ??
    (await text({ message: "What were you trying to do?", validate: nonEmpty })).trim();
  const attempted =
    fields.attempted ??
    (
      await editor({
        message: "What did you run, and what did you expect? (opens your editor)",
        postfix: ".md",
        validate: nonEmpty,
      })
    ).trim();
  const outcome =
    fields.outcome ??
    (await select<FeedbackOutcome>({
      message: "How did it end?",
      choices: [
        { value: "blocked", name: "blocked: could not finish" },
        { value: "worked_around", name: "worked_around: finished with a workaround" },
        {
          value: "succeeded_with_friction",
          name: "succeeded_with_friction: finished, but harder than it should be",
        },
      ],
    }));
  const issue =
    fields.issue ??
    (
      await editor({
        message: "What went wrong or was confusing? (opens your editor)",
        postfix: ".md",
        validate: nonEmpty,
      })
    ).trim();
  return { ...fields, goal, attempted, outcome, issue };
}

/** The report as sent. `redactions` is the sum across the free-text fields. */
type FeedbackPayload = TelemetryEnvelope & {
  report_id: string;
  source: "cli";
  goal: string;
  attempted: string;
  issue: string;
  outcome: FeedbackOutcome;
  command: string | null;
  error_text: string | null;
  error_code: string | null;
  suggestion: string | null;
  redactions: number;
};

/**
 * The exact key list is pinned by a test, like the command event's: the
 * warehouse parses this payload by key. Built from the named fields and the
 * envelope only; never from files, environment variables, transcripts or argv.
 * Called once per run: the object it returns is previewed and then sent.
 */
function buildPayload(
  fields: CompleteFields,
  envelope: TelemetryEnvelope,
  reportId: string,
): FeedbackPayload {
  const goal = redactAndCap(fields.goal, FIELD_CAPS.goal);
  const attempted = redactAndCap(fields.attempted, FIELD_CAPS.attempted);
  const issue = redactAndCap(fields.issue, FIELD_CAPS.issue);
  const errorText =
    fields.errorText === null ? null : redactAndCap(fields.errorText, FIELD_CAPS.error_text);
  const suggestion =
    fields.suggestion === null ? null : redactAndCap(fields.suggestion, FIELD_CAPS.suggestion);
  const redactions =
    goal.redactions +
    attempted.redactions +
    issue.redactions +
    (errorText?.redactions ?? 0) +
    (suggestion?.redactions ?? 0);
  return {
    ...envelope,
    report_id: reportId,
    source: "cli",
    goal: goal.text,
    attempted: attempted.text,
    issue: issue.text,
    outcome: fields.outcome,
    command: fields.command,
    error_text: errorText?.text ?? null,
    error_code: fields.errorCode,
    suggestion: suggestion?.text ?? null,
    redactions,
  };
}

function refusalFor(status: TelemetryStatus): SendFailureReason | null {
  if (status.enabled) return null;
  return status.reason === "dev-build" ? "dev_build" : "telemetry_disabled";
}

/** Opt-out, then the cap. Null when the report may go. */
async function gate(fields: ValidatedFields): Promise<SendFailureReason | null> {
  const refused = refusalFor(await getTelemetryStatus());
  if (refused) return refused;
  const recent = await readRecentFeedbackSends();
  const verdict = checkFeedbackRateLimit(recent, {
    command: fields.command,
    errorCode: fields.errorCode,
  });
  if (!verdict.allowed) return "rate_limited";
  return null;
}

function describeFailure(reason: SendFailureReason): string {
  switch (reason) {
    case "telemetry_disabled":
      return "Telemetry is disabled on this machine, so `clerk feedback` sends nothing (`clerk telemetry status` says why).";
    case "dev_build":
      return "This is a dev build, where telemetry is off, so `clerk feedback` sends nothing.";
    case "rate_limited":
      return "This machine has reached its feedback limit: 10 reports in 24 hours, or a repeat of the same command and error code.";
    case "send_failed":
      return "The report could not be sent (the endpoint did not accept it in time).";
  }
}

function printResult(result: FeedbackResult): void {
  if (isAgent()) {
    log.data(JSON.stringify(result));
    return;
  }
  if (result.sent) {
    log.success(`Sent. Thank you. Report id: ${result.report_id}`);
    return;
  }
  log.warn(describeFailure(result.reason));
  log.info(`You can file it instead at ${result.fallback}`);
  if (result.report_id) log.info(`Report id: ${result.report_id}`);
}

function printPayload(payload: FeedbackPayload): void {
  log.data(JSON.stringify(payload, null, 2));
}

function refusal(reason: SendFailureReason): FeedbackResult {
  return { sent: false, reason, fallback: GITHUB_ISSUES_URL };
}

/**
 * POST the report exactly as built. The shared sender re-checks the opt-out at
 * the moment of sending; a refusal there is reported as `telemetry_disabled`
 * with no report id, since nothing was attempted. A rejected POST, a timeout
 * or a network failure is `send_failed` with the id: a timed-out send can
 * still have reached the endpoint, and the id is what a later removal needs.
 * Only an accepted send is recorded against the cap.
 */
async function send(payload: FeedbackPayload): Promise<FeedbackResult> {
  // An opt-out that landed during the confirmation must not consume the
  // first-run notice: shown and marked here, it would promise two events
  // that never go, and a later opt-in would then never see the notice at
  // all. The shared sender checks again at the POST itself.
  const refused = refusalFor(await getTelemetryStatus());
  if (refused) return refusal(refused);

  // Immediately before the POST, so the notice never promises a report that
  // an opt-out, the cap or a declined confirmation stopped. The run's own
  // command event then sends too, which the changed last line discloses.
  await showTelemetryNoticeOnce(FEEDBACK_NOTICE_LAST_LINE);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_SEND_TIMEOUT_MS);
  let outcome: "accepted" | "rejected" | "disabled";
  try {
    outcome = await sendTelemetryEvent(
      { event: FEEDBACK_EVENT, payload },
      { signal: controller.signal },
    );
  } catch (error) {
    log.debug(`feedback: send failed: ${error}`);
    outcome = "rejected";
  } finally {
    clearTimeout(timer);
  }

  if (outcome === "disabled") return refusal("telemetry_disabled");
  if (outcome === "rejected") {
    return { ...refusal("send_failed"), report_id: payload.report_id };
  }
  await recordFeedbackSend({
    sentAt: Date.now(),
    command: payload.command,
    errorCode: payload.error_code,
  });
  return { sent: true, report_id: payload.report_id };
}

/**
 * Order of operations, per mode (the two differ only in where presence of
 * the required fields is checked: before gating for an agent, because the
 * contract says missing input is a usage error and nothing is typed; after
 * gating for a person, so someone opted out or capped is told before writing
 * a report):
 *
 * Agent: shape → presence → dry-run → opt-out → cap → notice → POST.
 * Human: shape → dry-run (prompting first) → opt-out → cap → prompts →
 * opt-out again → preview and confirmation → notice → POST.
 *
 * The second human-mode opt-out check runs after the prompts and before the
 * envelope is built: an opt-out that landed while the editor was open is
 * honoured without a preview and without creating a machine id.
 *
 * A failed or refused send is exit 0 in both modes: telemetry never affects
 * the command, and a script wrapping this one gets the same guarantee.
 */
export async function feedback(options: FeedbackOptions, tree: CommandTree): Promise<void> {
  const root = rootOf(tree);
  const fields = validateShape(options, root);
  // Generated before anything else so a dry run shows the id a send would carry.
  const reportId = crypto.randomUUID();

  if (isAgent()) {
    const complete = requireFields(fields);
    if (options.dryRun) {
      printPayload(buildPayload(complete, await buildTelemetryEnvelope(), reportId));
      return;
    }
    const refused = await gate(complete);
    if (refused) {
      printResult(refusal(refused));
      return;
    }
    const payload = buildPayload(complete, await buildTelemetryEnvelope(), reportId);
    printResult(await send(payload));
    return;
  }

  if (options.dryRun) {
    const complete = await promptMissingFields(fields);
    printPayload(buildPayload(complete, await buildTelemetryEnvelope(), reportId));
    log.info(
      "Dry run: no report was sent. (The usual usage event for this command still applies, and a machine id may have been created locally.)",
    );
    return;
  }

  const refused = await gate(fields);
  if (refused) {
    printResult(refusal(refused));
    return;
  }

  const complete = await promptMissingFields(fields);
  const refusedAfterPrompts = refusalFor(await getTelemetryStatus());
  if (refusedAfterPrompts) {
    printResult(refusal(refusedAfterPrompts));
    return;
  }

  const payload = buildPayload(complete, await buildTelemetryEnvelope(), reportId);
  log.info("This is exactly what will be sent:");
  printPayload(payload);
  log.info(
    `${payload.redactions} ${payload.redactions === 1 ? "replacement" : "replacements"} made for secrets, home paths or email addresses.`,
  );
  if (!options.yes) {
    const ok = await confirm({ message: "Send this report to Clerk?", default: true });
    if (!ok) throwUserAbort();
  }
  printResult(await send(payload));
}
