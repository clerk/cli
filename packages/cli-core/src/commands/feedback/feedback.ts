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
 * is open), again before the first-run notice, and once more inside the
 * shared sender at the moment of the POST.
 *
 * Every free-text field is scrubbed on the client (`lib/redact.ts`) before it
 * is capped and before anything leaves the machine. The report never attaches
 * files, environment variables, transcripts or argv: the payload is built
 * only from the fields named below plus the telemetry envelope, and it is
 * built once, so the preview a person confirms is the object that is sent.
 *
 * Telemetry must never affect the command: a config file that cannot be
 * written or read (no machine id yet, read-only directory) is a
 * `send_failed`, not a crash, matching how the per-run flush swallows the
 * same failure. The report id is printed exactly when a POST was attempted,
 * because it is the handle for a later removal and means nothing otherwise.
 * Ctrl-C is the one exception: it follows the CLI's interrupt path (exit 130
 * from the signal handler) and prints no result.
 */

import {
  FEEDBACK_DAILY_LIMIT,
  FEEDBACK_FIELD_MAX_LENGTH,
  FEEDBACK_SEND_TIMEOUT_MS,
  FEEDBACK_WINDOW_MS,
  GITHUB_ISSUES_URL,
} from "../../lib/constants.ts";
import { probeConfigWritable } from "../../lib/config.ts";
import { throwUsageError, throwUserAbort } from "../../lib/errors.ts";
import type { Example } from "../../lib/help.ts";
import { select } from "../../lib/listage.ts";
import { log } from "../../lib/log.ts";
import { confirm, editor, text } from "../../lib/prompts.ts";
import { redactAndCap } from "../../lib/redact.ts";
import { isCancelled } from "../../lib/signals.ts";
import {
  asPostedTelemetryEvent,
  buildTelemetryEnvelope,
  getTelemetryStatus,
  isTelemetryNoticeOwed,
  peekTelemetryEnvelope,
  type PostedTelemetryEvent,
  type SendOutcome,
  sendTelemetryEvent,
  showTelemetryNoticeOnce,
  type TelemetryEnvelope,
  type TelemetryEnvelopePreview,
  type TelemetryStatus,
} from "../../lib/telemetry.ts";
import { isAgent } from "../../mode.ts";
import {
  checkFeedbackRateLimit,
  readRecentFeedbackSends,
  recordFeedbackSend,
  type RateLimitVerdict,
} from "./rate-limit.ts";

export const FEEDBACK_EVENT = "CLI_FEEDBACK";

/**
 * Same values as the MCP server's `submit_feedback` tool, so the two sources
 * combine. The one list the help text, the prompt and the shell completion
 * all derive from.
 */
export const FEEDBACK_OUTCOME_CHOICES = [
  { value: "blocked", description: "Could not finish" },
  { value: "worked_around", description: "Finished with a workaround" },
  { value: "succeeded_with_friction", description: "Finished, but harder than it should be" },
] as const;
export type FeedbackOutcome = (typeof FEEDBACK_OUTCOME_CHOICES)[number]["value"];
export const FEEDBACK_OUTCOMES: readonly FeedbackOutcome[] = FEEDBACK_OUTCOME_CHOICES.map(
  (choice) => choice.value,
);

/** The MCP tool's caps, applied after scrubbing (see `redactAndCap`). */
const FIELD_CAPS = {
  goal: 2000,
  attempted: 4000,
  issue: 4000,
  error_text: 4000,
  suggestion: 2000,
} as const;

/**
 * What the event attaches to a report besides its fields, one phrase per
 * field, in the order the help text lists them: the telemetry envelope, and
 * the CLI version every event carries (`sdkv`). Typed against the envelope so
 * a new envelope field cannot ship without a phrase, and pinned against the
 * command's README by a test so the two always name the same fields.
 */
export const ATTACHED_FIELDS: Readonly<Record<keyof TelemetryEnvelope | "sdkv", string>> = {
  machine_uuid: "a random machine id",
  sdkv: "CLI version",
  install_method: "install method",
  ai_agent: "detected AI agent",
  terminal_program: "terminal",
  mode: "mode",
  os: "OS",
  arch: "architecture",
  ci: "CI flag",
  in_tmux: "tmux and screen flags",
  in_screen: "tmux and screen flags",
  env: "environment name",
  workspace_id: "workspace and app ids when a project is linked",
  app_id: "workspace and app ids when a project is linked",
};

/** The phrases above, each once, for the help text and the README test. */
export const ATTACHED_FIELD_PHRASES: readonly string[] = [
  ...new Set(Object.values(ATTACHED_FIELDS)),
];

/** The ceiling as the help text and the usage error print it. */
export const FIELD_MAX_LENGTH_TEXT = `${FEEDBACK_FIELD_MAX_LENGTH.toLocaleString("en-US")} characters`;

/** The shape every `ERROR_CODE` value and API error code has. */
const ERROR_CODE_PATTERN = /^[a-z0-9_]{1,64}$/;

const FEEDBACK_NOTICE_LAST_LINE =
  "This run sends the feedback report you asked for and one usage event for this command.";

const WINDOW_HOURS = Math.round(FEEDBACK_WINDOW_MS / (60 * 60 * 1000));

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
 * against. The underscored fields are Commander's own private state, read
 * the same way `__complete.ts` reads `_hidden`: which child runs when the
 * group is invoked bare, whether the group runs anything itself, and whether
 * a command is hidden from help (and so from the subcommands an error
 * suggests).
 */
export type CommandTree = {
  name(): string;
  aliases(): string[];
  commands: readonly CommandTree[];
  parent: CommandTree | null;
  registeredArguments?: readonly unknown[];
  _defaultCommandName?: string | null;
  _actionHandler?: unknown;
  _hidden?: boolean;
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

/** The feedback event as it is posted (and as the preview and `--dry-run` show it). */
export type PostedFeedbackEvent = PostedTelemetryEvent<{
  event: typeof FEEDBACK_EVENT;
  payload: FeedbackPayload;
}>;

/** The agent-mode `--dry-run` output: the event a real run would post, and whether it would post it now. */
export type DryRunResult = {
  dry_run: true;
  would_send: boolean;
  reason?: SendFailureReason;
  event: PostedFeedbackEvent;
};

/** Why a send was refused, with the detail the human-mode message needs and the JSON omits. */
type Refusal = {
  reason: SendFailureReason;
  limit?: Exclude<RateLimitVerdict, { allowed: true }>["reason"];
};

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
 * `impersonate`), the default child's argument if that child takes one
 * (`open users` → `open dashboard`), and an error otherwise (`users lst`,
 * `deploy statsu`). A group with a default child is recorded as that child
 * (`deploy` → `deploy run`). A bare group that runs nothing itself (`auth`)
 * never appears in usage events, so it is an error that names its
 * subcommands.
 *
 * `clerk help [command]` is Commander's own help command: it prints help and
 * exits before any usage event starts, so no event carries a spelling for
 * it. It is accepted as typed (`help users`), for any command that exists,
 * groups included, because that is what the person ran.
 */
export function resolveCommand(tree: CommandTree, input: string): CommandResolution {
  const words = input.trim().split(/\s+/).filter(Boolean);
  if (words[0] === "clerk") words.shift();
  if (words[0] === "help") return resolveHelp(tree, words.slice(1));
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
      subcommands: node.commands
        .filter((c) => !c._hidden)
        .map((c) => `${parts.join(" ")} ${c.name()}`),
    };
  }
  return { path: parts.join(" ") };
}

/** `help` followed by the path of an existing command, walked by name only (no default child, no arguments). */
function resolveHelp(tree: CommandTree, words: string[]): CommandResolution {
  let node = tree;
  const parts = ["help"];
  for (const word of words) {
    if (word.startsWith("-")) break;
    const child = findChild(node, word);
    if (!child) return { path: null, reason: "unknown" };
    parts.push(child.name());
    node = child;
  }
  return { path: parts.join(" ") };
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

/** The free-text options by flag name, for the ceiling check. */
const TEXT_OPTIONS = (options: FeedbackOptions): Record<string, string | undefined> => ({
  goal: options.goal,
  attempted: options.attempted,
  issue: options.issue,
  "error-text": options.errorText,
  suggestion: options.suggestion,
});

/** Prompt validation: required, and under the ceiling. */
const nonEmptyUnderCeiling = (value: string | undefined): string | undefined => {
  if (!value?.trim()) return "This field is required.";
  if (value.length > FEEDBACK_FIELD_MAX_LENGTH) {
    return `This is ${value.length.toLocaleString("en-US")} characters; the limit is ${FIELD_MAX_LENGTH_TEXT}.`;
  }
  return undefined;
};

/**
 * Step 1 in both modes: the shape of whatever was supplied. Presence of the
 * required fields is checked afterwards, differently per mode. Validated here
 * rather than with Commander's `.choices()`, which rejects a value with plain
 * text and exit 1 before any hook runs; a usage error from the handler gets
 * the JSON envelope, exit 2 and the examples.
 */
function validateShape(options: FeedbackOptions, tree: CommandTree): ValidatedFields {
  for (const [name, value] of Object.entries(TEXT_OPTIONS(options))) {
    if (value !== undefined && value.length > FEEDBACK_FIELD_MAX_LENGTH) {
      throwUsageError(
        `--${name} is ${value.length.toLocaleString("en-US")} characters; the limit is ${FIELD_MAX_LENGTH_TEXT}. Shorten it to what describes the problem.`,
        undefined,
        undefined,
        FEEDBACK_EXAMPLES,
      );
    }
  }

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

/** Human mode: ask for whatever was not passed as a flag. `--command` and `--error-code` are flags only. */
async function promptMissingFields(fields: ValidatedFields): Promise<CompleteFields> {
  const goal =
    fields.goal ??
    (await text({ message: "What were you trying to do?", validate: nonEmptyUnderCeiling })).trim();
  const attempted =
    fields.attempted ??
    (
      await editor({
        message: "What did you run, and what did you expect? (opens your editor)",
        postfix: ".md",
        validate: nonEmptyUnderCeiling,
      })
    ).trim();
  const outcome =
    fields.outcome ??
    (await select<FeedbackOutcome>({
      message: "How did it end?",
      choices: FEEDBACK_OUTCOME_CHOICES.map((choice) => ({
        value: choice.value,
        name: `${choice.value}: ${choice.description}`,
      })),
    }));
  const issue =
    fields.issue ??
    (
      await editor({
        message: "What went wrong or was confusing? (opens your editor)",
        postfix: ".md",
        validate: nonEmptyUnderCeiling,
      })
    ).trim();
  return { ...fields, goal, attempted, outcome, issue };
}

/** The report as sent. `redactions` is the sum across the free-text fields. */
export type FeedbackPayload = TelemetryEnvelopePreview & {
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
  envelope: TelemetryEnvelopePreview,
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

/** The envelope for a real send, or null when the config file cannot be written (no machine id yet). */
async function buildEnvelopeOrNull(): Promise<TelemetryEnvelope | null> {
  try {
    return await buildTelemetryEnvelope();
  } catch (error) {
    log.debug(`feedback: could not build the telemetry envelope: ${error}`);
    return null;
  }
}

function refusalFor(status: TelemetryStatus): Refusal | null {
  if (status.enabled) return null;
  return { reason: status.reason === "dev-build" ? "dev_build" : "telemetry_disabled" };
}

/** Opt-out, then the cap. Null when the report may go; `send_failed` when the config file cannot be read. */
async function gate(fields: ValidatedFields): Promise<Refusal | null> {
  const refused = await currentRefusal();
  if (refused) return refused;
  const recent = await readRecentFeedbackSends();
  const verdict = checkFeedbackRateLimit(recent, {
    command: fields.command,
    errorCode: fields.errorCode,
  });
  if (!verdict.allowed) return { reason: "rate_limited", limit: verdict.reason };
  return null;
}

function describeRefusal(refusal: Refusal): string {
  switch (refusal.reason) {
    case "telemetry_disabled":
      return "Telemetry is disabled on this machine, so `clerk feedback` sends nothing (`clerk telemetry status` says why).";
    case "dev_build":
      return "This is a dev build, where telemetry is off, so `clerk feedback` sends nothing.";
    case "rate_limited":
      return refusal.limit === "repeat"
        ? `This machine already sent a report with the same command and error code in the last ${WINDOW_HOURS} hours.`
        : `This machine has sent ${FEEDBACK_DAILY_LIMIT} reports in ${WINDOW_HOURS} hours, which is the limit.`;
    case "send_failed":
      return "The report could not be sent (the endpoint did not accept it in time, or the local config could not be written).";
  }
}

function resultOf(refusal: Refusal, reportId?: string): FeedbackResult {
  return {
    sent: false,
    reason: refusal.reason,
    fallback: GITHUB_ISSUES_URL,
    ...(reportId ? { report_id: reportId } : {}),
  };
}

function printRefusal(refusal: Refusal, reportId?: string): void {
  const result = resultOf(refusal, reportId);
  if (isAgent()) {
    log.data(JSON.stringify(result));
    return;
  }
  log.warn(describeRefusal(refusal));
  log.info(`You can file it instead at ${GITHUB_ISSUES_URL}`);
  if (reportId) log.info(`Report id: ${reportId}`);
}

function printSent(reportId: string): void {
  if (isAgent()) {
    log.data(JSON.stringify({ sent: true, report_id: reportId } satisfies FeedbackResult));
    return;
  }
  log.success(`Sent. Thank you. Report id: ${reportId}`);
}

/** The report as the event the CLI posts: `sdk`, `sdkv` (the CLI version), the event name and the payload. */
function feedbackEvent(payload: FeedbackPayload): PostedFeedbackEvent {
  return asPostedTelemetryEvent({ event: FEEDBACK_EVENT, payload });
}

function printEvent(payload: FeedbackPayload): void {
  log.data(JSON.stringify(feedbackEvent(payload), null, 2));
}

/** What became of a feedback send: sent, or refused, with whether a POST was attempted (which earns the report id). */
type FeedbackSendResult = { sent: true } | { sent: false; refusal: Refusal; posted: boolean };

/**
 * Connection failures where the request never left the machine: a refused
 * connection, a host that does not resolve, no network. Bun reports both a
 * refused connection and an unresolvable host as `ConnectionRefused`; the
 * Node-style codes cover the same failures from other runtimes and proxies.
 */
const CONNECTION_NEVER_MADE = new Set([
  "ConnectionRefused",
  "FailedToOpenSocket",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "ENETUNREACH",
  "ENETDOWN",
  "EHOSTUNREACH",
]);

/**
 * Whether a failed request may still have reached the server. Anything the
 * CLI cannot place counts as yes, and so does a timeout: the CLI cannot tell a
 * timeout before the connection from one after the request was sent.
 */
function mayHaveReachedServer(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return !(typeof code === "string" && CONNECTION_NEVER_MADE.has(code));
}

/**
 * POST the report exactly as built and say what became of it; the caller
 * prints the result. The opt-out is read once more before the first-run
 * notice, so an opt-out that landed during the confirmation neither posts nor
 * consumes the notice; the shared sender checks again at the POST.
 *
 * `posted` is true once the sender has passed its opt-out check and made the
 * request, and it is what earns the report id: a rejected POST, a timeout or
 * a network failure is `send_failed` with the id, since the id is what a
 * later removal needs; a failure before the POST (the config could not be
 * read, the notice could not be recorded) is `send_failed` without one.
 *
 * The cap counts a send whenever the request may have reached the server: any
 * response, a timeout, or a failure the CLI cannot place. A connection that
 * was never made sent nothing and is not counted. An interrupt is rethrown
 * for the CLI's interrupt path.
 */
async function send(payload: FeedbackPayload): Promise<FeedbackSendResult> {
  try {
    const refused = refusalFor(await getTelemetryStatus());
    if (refused) return { sent: false, refusal: refused, posted: false };
    // Immediately before the POST, so the notice never promises a report that
    // an opt-out, the cap or a declined confirmation stopped. The run's own
    // command event then sends too, which the changed last line discloses.
    await showTelemetryNoticeOnce(FEEDBACK_NOTICE_LAST_LINE);
  } catch (error) {
    log.debug(`feedback: could not prepare the send: ${error}`);
    return { sent: false, refusal: { reason: "send_failed" }, posted: false };
  }

  let posted = false;
  let reached: boolean;
  let outcome: SendOutcome;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FEEDBACK_SEND_TIMEOUT_MS);
  try {
    outcome = await sendTelemetryEvent(
      { event: FEEDBACK_EVENT, payload },
      {
        signal: controller.signal,
        onPost: () => {
          posted = true;
        },
      },
    );
    reached = outcome !== "disabled";
  } catch (error) {
    if (isCancelled(error)) throw error;
    log.debug(`feedback: send failed: ${error}`);
    outcome = "rejected";
    reached = posted && mayHaveReachedServer(error);
  } finally {
    clearTimeout(timer);
  }

  if (reached) {
    await recordFeedbackSend({
      sentAt: Date.now(),
      command: payload.command,
      errorCode: payload.error_code,
    });
  }
  if (outcome === "disabled") {
    return { sent: false, refusal: { reason: "telemetry_disabled" }, posted: false };
  }
  if (outcome === "rejected") return { sent: false, refusal: { reason: "send_failed" }, posted };
  return { sent: true };
}

function printOutcome(outcome: FeedbackSendResult, reportId: string): void {
  if (outcome.sent) return printSent(reportId);
  printRefusal(outcome.refusal, outcome.posted ? reportId : undefined);
}

/** The opt-out as of now; a config file that cannot be read is `send_failed`, never a crash. */
async function currentRefusal(): Promise<Refusal | null> {
  try {
    return refusalFor(await getTelemetryStatus());
  } catch (error) {
    log.debug(`feedback: could not read the telemetry status: ${error}`);
    return { reason: "send_failed" };
  }
}

/**
 * What a dry run would report: the refusal a real run would meet now, and the
 * envelope to show. Creates a machine id only when telemetry is on: an
 * opted-out machine shows the id it already has, or null.
 */
async function dryRunVerdict(
  fields: CompleteFields,
): Promise<{ refusal: Refusal | null; envelope: TelemetryEnvelopePreview }> {
  let refusal = await gate(fields);
  const telemetryOff = refusal?.reason === "telemetry_disabled" || refusal?.reason === "dev_build";
  if (telemetryOff) return { refusal, envelope: await peekTelemetryEnvelope() };
  // `would_send` must be false in exactly the states where a real run
  // reports `send_failed`: the machine id cannot be created, or the
  // first-run notice is still owed and could not be recorded. The second is
  // a write probe next to the config file, never a write to it.
  const built = await buildEnvelopeOrNull();
  const envelope = built ?? (await peekTelemetryEnvelope());
  const cannotWrite =
    built === null || ((await isTelemetryNoticeOwed()) && !(await probeConfigWritable()));
  if (cannotWrite) refusal ??= { reason: "send_failed" };
  return { refusal, envelope };
}

/**
 * `--dry-run`: the exact event, and whether a real run would send it now.
 * Runs before the gates on purpose (it is how someone sees what would be
 * sent) but reports what the gates would say. Whatever fails while deciding,
 * it prints its own shape, with `send_failed`.
 */
async function dryRun(fields: CompleteFields, reportId: string): Promise<void> {
  let verdict: { refusal: Refusal | null; envelope: TelemetryEnvelopePreview };
  try {
    verdict = await dryRunVerdict(fields);
  } catch (error) {
    log.debug(`feedback: dry run could not decide: ${error}`);
    verdict = { refusal: { reason: "send_failed" }, envelope: await peekTelemetryEnvelope() };
  }
  const { refusal, envelope } = verdict;
  const report = buildPayload(fields, envelope, reportId);

  if (isAgent()) {
    const result: DryRunResult = {
      dry_run: true,
      would_send: refusal === null,
      ...(refusal ? { reason: refusal.reason } : {}),
      event: feedbackEvent(report),
    };
    log.data(JSON.stringify(result));
    return;
  }

  printEvent(report);
  log.info("Dry run: no report was sent. (The usual usage event for this command still applies.)");
  if (refusal) log.warn(`A real run would not send this report now: ${describeRefusal(refusal)}`);
  else log.info("A real run would send this report now.");
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
 * Only the telemetry steps (the gates, the envelope, the send) turn a failure
 * into `send_failed`; each catches its own. A failing prompt or editor is the
 * person's to see and surfaces as its own error. A failed or refused send is
 * exit 0 in both modes: telemetry never affects the command, and a script
 * wrapping this one gets the same guarantee.
 */
export async function feedback(options: FeedbackOptions, tree: CommandTree): Promise<void> {
  const root = rootOf(tree);
  const fields = validateShape(options, root);
  // Generated before anything else so a dry run shows the id a send would carry.
  const reportId = crypto.randomUUID();

  if (isAgent()) {
    const complete = requireFields(fields);
    if (options.dryRun) return dryRun(complete, reportId);
    const refused = await gate(complete);
    if (refused) return printRefusal(refused);
    const envelope = await buildEnvelopeOrNull();
    if (!envelope) return printRefusal({ reason: "send_failed" });
    return printOutcome(await send(buildPayload(complete, envelope, reportId)), reportId);
  }

  if (options.dryRun) return dryRun(await promptMissingFields(fields), reportId);

  const refused = await gate(fields);
  if (refused) return printRefusal(refused);

  const complete = await promptMissingFields(fields);
  const refusedAfterPrompts = await currentRefusal();
  if (refusedAfterPrompts) return printRefusal(refusedAfterPrompts);

  const envelope = await buildEnvelopeOrNull();
  if (!envelope) return printRefusal({ reason: "send_failed" });
  const payload = buildPayload(complete, envelope, reportId);
  log.info("This is exactly what will be sent:");
  printEvent(payload);
  log.info(
    `${payload.redactions} ${payload.redactions === 1 ? "replacement" : "replacements"} made for secrets, home paths or email addresses.`,
  );
  if (!options.yes) {
    const ok = await confirm({ message: "Send this report to Clerk?", default: true });
    if (!ok) throwUserAbort();
  }
  return printOutcome(await send(payload), reportId);
}
