/**
 * Per-invocation usage telemetry.
 *
 * One CLI_COMMAND_EXECUTED event per command run — except `completion`, which
 * never emits (see startCommandTelemetry) — POSTed to the
 * telemetry-service worker (BigQuery behind it). Opt out with
 * `clerk telemetry disable` (persisted) or the CLERK_TELEMETRY_DISABLED /
 * DO_NOT_TRACK env vars. Dev builds send nothing unless CLERK_TELEMETRY_URL
 * overrides the endpoint (test escape hatch).
 *
 * Telemetry must never affect the command: every entry point swallows its
 * own failures to log.debug and the send is capped at TELEMETRY_TIMEOUT_MS.
 */

import { DEFAULT_TELEMETRY_ENDPOINT, TELEMETRY_TIMEOUT_MS } from "./constants.ts";
import {
  ensureMachineUuid,
  getTelemetryDisabled,
  markTelemetryNoticeShown,
  resolveProfile,
} from "./config.ts";
import {
  detectAiAgent,
  detectInScreen,
  detectInstallMethod,
  detectInTmux,
  detectTerminalProgram,
  optOutEnvVar,
  type EnvLike,
  type OptOutEnvVar,
} from "./env-signals.ts";
import { getCurrentEnvName } from "./environment.ts";
import { ApiError, CliError, EXIT_CODE, UserAbortError } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";
import { getMode } from "../mode.ts";
import { CURRENT_VERSION, IS_DEV_BUILD } from "./version.ts";

/**
 * What happened to the command, not to the thing it acted on.
 *
 * `incomplete` says the command ran and the thing it reports on is not
 * finished — nobody is being asked to do anything, and nothing failed. Only
 * `clerk deploy status` sends it, and only by declaring it (see
 * {@link declareSoftExitOutcome}); it is never a mapping of nonzero exits.
 *
 * `success` is not "the deploy is done" either: `clerk deploy` under an agent
 * prints a status report and exits 0 with nothing started. How far a deploy
 * got is `stage` and `components`, never `outcome`.
 */
export type TelemetryOutcome = "success" | "error" | "abort" | "incomplete";

/**
 * What a command may declare for itself on the soft-exit path.
 *
 * Deliberately narrower than {@link TelemetryOutcome}. `success` is excluded
 * because the warehouse classifies a row by `outcome` before it looks at
 * anything else (as of data-platform#604), so declaring it on a run that then
 * exits nonzero would file a failure as a success. `abort` is excluded because
 * it belongs to the interrupt path, which reports itself.
 */
export type SoftExitOutcome = "incomplete" | "error";

export type TelemetryResult = {
  outcome: TelemetryOutcome;
  exitCode: number;
  errorCode?: string;
};

/**
 * Where a `clerk deploy` run stopped when the user has something left to do.
 * Narrower than `stage`: on a fresh deploy the DNS handoff runs before OAuth
 * setup, so someone who skips a provider is at `stage: "domain_pending"` and
 * `pauseStep: "oauth"`. Set by the deploy wizard (GROW-1233).
 */
export type TelemetryPauseStep = "dns" | "oauth";

/**
 * Per-component readiness at the time the run ended. `null` means never
 * observed — no successful status read established it — and must never be
 * read as `false`: a failed status call is not a DNS failure. Filled by the
 * deploy wizard and `clerk deploy status` (GROW-1233).
 */
export type TelemetryComponents = {
  dns: boolean | null;
  ssl: boolean | null;
  mail: boolean | null;
  oauth: boolean | null;
};

/**
 * Closed set of drop-off points a command can report. A union rather than a
 * bare string so a typo or a rename that misses a call site fails to compile
 * instead of silently splitting the funnel into two buckets in the warehouse,
 * and so no interpolated value (a path, a project name) can reach the payload.
 *
 * Declared in execution order, grouped per command: each group is that
 * command's funnel, so a new stage goes where it runs, not at the end.
 * `already_set_up` is a terminal branch off `scaffold`.
 */
export type TelemetryStage =
  // `clerk init`
  | "flags"
  | "detect"
  | "bootstrap"
  | "strategy"
  | "link"
  | "install"
  | "scaffold"
  | "already_set_up"
  | "keys"
  | "skills"
  // `clerk auth login`
  | "session_check"
  | "awaiting_callback"
  | "token_exchange"
  | "store"
  | "first_application"
  // `clerk deploy` and `clerk deploy status`
  //
  // Unlike the groups above, these are not control-flow positions: each is a
  // state of the deploy itself, as `resolveActiveReportState` in
  // `commands/deploy/report-state.ts` would compute it at that moment. So the stage
  // a wizard run reports and the stage `clerk deploy status` reports a second
  // later agree about the same deploy. One value per run — the last state
  // observed, not every state the run passed through — and a run that ends
  // before any state resolves sends null rather than defaulting: "never
  // established" is a distinct answer from "not started".
  //
  // A finished deploy is `complete`, never the shared `done` marker below:
  // the warehouse's payload contract test accepts exactly these five values
  // on `deploy run` and `deploy status`, so `done` there trips it on every
  // finished deploy.
  | "not_started"
  | "domain_provisioning"
  | "domain_pending"
  | "oauth_pending"
  | "complete"
  // shared terminal marker
  | "done";

/** Structural slice of Commander's Command — avoids its generic types. */
export type TelemetryCommand = {
  name(): string;
  options: readonly { name(): string; attributeName(): string }[];
  getOptionValueSource(key: string): string | undefined;
  parent: TelemetryCommand | null;
};

type TelemetryContext = {
  command: string;
  flags: string;
  startedAt: number;
  /** Last stage set — see setTelemetryStage. */
  stage: TelemetryStage | null;
  /** Declared by the command for the soft-exit path — see declareSoftExitOutcome. */
  softExit: SoftExitDeclaration | null;
  /** Where the deploy wizard stopped — see TelemetryPauseStep. */
  pauseStep: TelemetryPauseStep | null;
  /** Per-component readiness, each field written only by an observation. */
  components: TelemetryComponents;
};

/**
 * What a command wants recorded when it reports failure through
 * `process.exitCode` rather than by throwing. The error code is optional
 * because `clerk deploy status` has none to give: nothing was thrown, so
 * there is no code, and `incomplete` is the whole answer.
 */
type SoftExitDeclaration = {
  outcome: SoftExitOutcome;
  errorCode?: string;
};

function emptyComponents(): TelemetryComponents {
  return { dns: null, ssl: null, mail: null, oauth: null };
}

let context: TelemetryContext | null = null;

/**
 * Whether this run has been accounted for — the send completed, or it was
 * decided that nothing would be sent at all (opt-out, disclosure notice).
 *
 * The context is what a flush needs to build an event, so it is held until one
 * of those settles rather than cleared at entry. A Ctrl-C mid-POST aborts the
 * normal flush, which leaves the context in place for the shutdown flush to
 * re-send as `outcome: "abort"` — before this the context was already gone and
 * an interrupted run reported nothing at all.
 *
 * This flag alone is what keeps a run to one event, and it is enough because a
 * normal flush still running when the shutdown flush starts can no longer
 * land: it passes `ignoreInterrupt: false`, so its POST is composed with
 * `interruptSignal()` and the interrupt that triggered the shutdown flush
 * already aborted it. One that landed *before* the interrupt has already set
 * this flag — its continuations are microtasks and the signal handler is a
 * macrotask, so they run first. The shutdown flush therefore never waits on
 * the normal one, whose remaining config, Git, and user-agent reads observe no
 * signal and could otherwise burn its entire 250ms budget.
 */
let finalized = false;

/** Pure env + build check; the persisted opt-out lives in getTelemetryStatus. */
export function telemetryEnabled(
  env: EnvLike = process.env,
  isDevBuild: boolean = IS_DEV_BUILD,
): boolean {
  if (optOutEnvVar(env)) return false;
  if (env.CLERK_TELEMETRY_URL) return true;
  return !isDevBuild;
}

export type TelemetryStatus =
  | { enabled: true }
  | { enabled: false; reason: "env"; envVar: OptOutEnvVar }
  | { enabled: false; reason: "config" }
  | { enabled: false; reason: "dev-build" };

/**
 * Effective enablement with the winning reason, in precedence order:
 * env opt-out > persisted `clerk telemetry disable` > dev-build guard.
 */
export async function getTelemetryStatus(
  env: EnvLike = process.env,
  isDevBuild: boolean = IS_DEV_BUILD,
): Promise<TelemetryStatus> {
  const envVar = optOutEnvVar(env);
  if (envVar) return { enabled: false, reason: "env", envVar };
  if (await getTelemetryDisabled()) return { enabled: false, reason: "config" };
  if (!telemetryEnabled(env, isDevBuild)) return { enabled: false, reason: "dev-build" };
  return { enabled: true };
}

/** "users list" for `clerk users list` — root name excluded, never raw argv. */
function commandPathOf(cmd: TelemetryCommand): string {
  const parts: string[] = [];
  for (let c: TelemetryCommand | null = cmd; c && c.parent; c = c.parent) {
    parts.unshift(c.name());
  }
  return parts.join(" ");
}

/** Names of flags explicitly set on the CLI (own + inherited), never values. */
function collectSetFlagNames(cmd: TelemetryCommand): string[] {
  const names: string[] = [];
  for (let c: TelemetryCommand | null = cmd; c; c = c.parent) {
    for (const option of c.options) {
      if (c.getOptionValueSource(option.attributeName()) === "cli") {
        names.push(option.name());
      }
    }
  }
  return names;
}

/** Pure in-memory; never throws. */
export function startCommandTelemetry(actionCommand: TelemetryCommand): void {
  try {
    const command = commandPathOf(actionCommand);
    // A process runs one command, but tests reuse the module — start each run
    // owing an event.
    finalized = false;
    // `completion` runs without a user asking for it: every new shell with
    // `eval "$(clerk completion zsh)"` in its rc file re-runs it, so a handful
    // of machines drowned out the real command mix. (`__complete`, fired on
    // each Tab press, exits in cli.ts before Commander reaches this hook.)
    if (command === "completion") {
      context = null;
      return;
    }
    context = {
      command,
      flags: collectSetFlagNames(actionCommand).join(","),
      startedAt: Date.now(),
      stage: null,
      softExit: null,
      pauseStep: null,
      components: emptyComponents(),
    };
  } catch (error) {
    log.debug(`telemetry: failed to start context: ${error}`);
  }
}

/**
 * Mark how far a multi-step command got. The last stage set is the one sent,
 * on every outcome — a success reports where it finished, an error or abort
 * reports where it stopped. That makes `stage` a drop-off funnel rather than
 * an error-only dimension: a user declining the scaffold preview and a
 * failure inside the generator are both legible, and distinguishable.
 */
export function setTelemetryStage(stage: TelemetryStage): void {
  if (context) context.stage = stage;
}

/**
 * Forget the stage. For the one case where an observation disproves the
 * stage last set without establishing a new one — a fresh deploy's create
 * call answering that an instance already exists, in `commands/deploy/index.ts`,
 * is the only caller. Not a general reset: a command that wants a different
 * stage sets it.
 */
export function clearTelemetryStage(): void {
  if (context) context.stage = null;
}

/** Read the stage a caller had set, so a nested flow can hand it back. */
export function currentTelemetryStage(): TelemetryStage | null {
  return context?.stage ?? null;
}

/**
 * Record the step a `clerk deploy` run stopped on. Set where the pause itself
 * is constructed, which is the one place that knows both that the run is
 * stopping and which step it stopped on — a caller that set it earlier would
 * have to unset it on every path that then carried on.
 *
 * Only set it for a step the *person* stopped on. A wait on Clerk's backend
 * ends the run at no step at all, and leaving the last step in place there
 * would count it as a drop-off nobody made.
 */
export function setTelemetryPauseStep(step: TelemetryPauseStep): void {
  if (context) context.pauseStep = step;
}

/**
 * Record what a successful domain-status read said about DNS, SSL and email
 * DNS. Only ever called with a live read's answer: the wizard's substituted
 * "everything pending" status and its fresh-run placeholder are not
 * observations, and recording either would file a network blip as a DNS
 * failure. Leaves `oauth` alone — it comes from a different read, and a
 * domain poll must not erase a good OAuth observation or re-send a stale one.
 */
export function setTelemetryDomainComponents(status: {
  dns: boolean;
  ssl: boolean;
  mail: boolean;
}): void {
  if (!context) return;
  context.components = {
    ...context.components,
    dns: status.dns,
    ssl: status.ssl,
    mail: status.mail,
  };
}

/**
 * Record whether every required OAuth provider has production credentials,
 * from a successful production-configuration read or a credential save.
 * "Required" is the CLI's rule as it stands — the providers enabled in
 * development that the wizard knows how to configure. GROW-1236 changes that
 * rule to read production configuration; this value follows automatically,
 * because it is computed from the same report. Leaves the domain group alone.
 */
export function setTelemetryOAuthComplete(complete: boolean): void {
  if (context) context.components = { ...context.components, oauth: complete };
}

/**
 * Declare what this run should be recorded as when it ends by setting
 * `process.exitCode` instead of throwing.
 *
 * Commands that catch their own failure never reach `telemetryResultForError`,
 * so without this the soft-exit branch in `cli-program.ts` can only say
 * "nonzero, therefore error". That is wrong in both directions: `clerk deploy
 * status` exits 1 on a deploy that simply is not finished, and `clerk api`
 * exits 1 holding an error code a throw would have recorded (see
 * {@link declareSoftExitError} for that side).
 *
 * Why this is a declaration and not a rule about exit codes: the exit code is
 * a per-command transport detail — 1 means "not done" from `deploy status`
 * and "request failed" from `api` — so only the command knows what its own
 * nonzero exit meant. A general mapping would relabel every command at once.
 *
 * Ignored when the run throws: a thrown error is the more specific fact, and
 * `runProgram` classifies it through {@link telemetryResultForError}.
 *
 * Two rules for callers:
 *
 * - **The last call wins.** Call this once, with the fact you want recorded.
 *   A command that aggregates failures across several targets and means to
 *   report the first one must select that error before calling, not call from
 *   inside its loop — which would record the last target's failure instead,
 *   with no test failing and telemetry naming the wrong thing.
 * - **It applies to whatever nonzero code the run ends with,** not only the
 *   one in force when it was called. Declare it under the same condition that
 *   sets the exit code, so the two cannot diverge.
 */
export function declareSoftExitOutcome(outcome: SoftExitOutcome, errorCode?: string): void {
  if (context) context.softExit = { outcome, errorCode };
}

/**
 * How a run that set `process.exitCode` and returned is recorded. Honors a
 * declaration only on a nonzero exit: a command that declared an outcome and
 * then succeeded anyway (a retry that worked, a later branch clearing the
 * code) is a success, and reporting the stale declaration would invent a
 * failure the user never saw.
 */
export function telemetryResultForSoftExit(exitCode: number): TelemetryResult {
  if (exitCode === EXIT_CODE.SUCCESS) return { outcome: "success", exitCode };
  const declared = context?.softExit;
  if (!declared) return { outcome: "error", exitCode };
  return {
    outcome: declared.outcome,
    exitCode,
    ...(declared.errorCode ? { errorCode: declared.errorCode } : {}),
  };
}

/**
 * Declare a failure the command caught and reported itself, carrying the code
 * a throw would have.
 *
 * `clerk api`, `clerk users create` and `clerk mcp install --json` each catch
 * their own error for a reason that stays as it is — the raw response body has
 * to reach stdout for piping, or a second JSON document must not follow the
 * first — and set the exit code instead. `telemetryResultForError` then never
 * runs, and the code the error was holding is lost. This is the same
 * classification, applied where the error is still in hand: a `CliError`
 * keeps its named code, anything unrecognised is `unexpected_error`, so
 * `mcp install --json` records what human mode records when it rethrows.
 *
 * The one difference from a throw: an `ApiError` with no parsed Clerk code is
 * split by HTTP status rather than collapsed onto `api_error`. See
 * {@link uncodedApiErrorCode} for why. Thrown `ApiError`s keep `api_error`
 * because that code is on the warehouse's reviewed failure list as it is.
 *
 * `userSuppliedPath` says who wrote the request path, which only the call
 * site knows and which decides what an uncoded 404 means: a person's typo, or
 * the CLI asking for a route the API does not serve. It is required rather
 * than defaulted so a new call site cannot mis-file a 404 by omission: the
 * BAPI commands build their own paths and pass false; `clerk api` passes true
 * for a path typed on the command line and false for one its interactive
 * builder chose from the endpoint catalog.
 *
 * Call it under the same condition that sets the exit code, and with the
 * error the run means to report — the last-call-wins rule on
 * {@link declareSoftExitOutcome} applies. Never hand it a `UserAbortError`:
 * a declaration cannot express an abort, so it would be recorded as
 * `unexpected_error`. A command that prompts inside a caught section must let
 * the abort throw instead. (No caller can reach this today; the MCP client
 * picker runs before any client is settled.)
 */
export function declareSoftExitError(error: unknown, options: { userSuppliedPath: boolean }): void {
  const code =
    error instanceof ApiError
      ? (error.code ?? uncodedApiErrorCode(error.status, options.userSuppliedPath))
      : (telemetryResultForError(error).errorCode ?? "unexpected_error");
  declareSoftExitOutcome("error", code);
}

/**
 * An API response with no Clerk error code in its body has one HTTP status and
 * no single meaning, so each code names exactly what was observed and nothing
 * more. Telemetry carries no status and no endpoint, so this split is the only
 * thing that makes the uncoded population measurable.
 *
 * - 429 → `api_rate_limited`, not the existing `too_many_requests`: that one
 *   arrives parsed from Clerk's error body, so it means Clerk itself said so.
 *   An uncoded 429 means no body said so — an empty body or an unexpected
 *   shape from Clerk parses the same as a proxy's answer, so the origin is
 *   unknown. Merging the two would erase the only distinction observable at
 *   the point of record.
 * - 404 with a path the person typed → `api_not_found`: the path did not
 *   reach a Clerk route, and the person chose it. The hint `clerk api`
 *   prints on this branch is a heuristic, so the code claims the status and
 *   who wrote the path, not the cause.
 * - 404 with a path the CLI built → `cli_endpoint_not_found`: the CLI asked
 *   for a route and nothing served it — a stale endpoint catalog, a hardcoded
 *   path the API dropped, or something in front of the API answering for it
 *   (`CLERK_BACKEND_API_URL` is overridable), the same ambiguity the 5xx
 *   bullet carries. The warehouse counts it as a failure. Kept apart from
 *   `api_not_found` because the same status means opposite things depending
 *   on who wrote the path, and the row cannot say which afterwards.
 * - other 4xx → `api_client_error`: 400, 401 and 403 collapsed. Cause and
 *   frequency unknown; the status cannot be recovered afterwards, so no
 *   finer mapping is promised.
 * - anything else → `api_error`: a 5xx is a failed request whoever caused it,
 *   Clerk or a customer's proxy — the same ambiguity every thrown `ApiError`
 *   carries today.
 */
function uncodedApiErrorCode(status: number, userSuppliedPath: boolean): string {
  if (status === 429) return "api_rate_limited";
  if (status === 404) return userSuppliedPath ? "api_not_found" : "cli_endpoint_not_found";
  if (status >= 400 && status < 500) return "api_client_error";
  return "api_error";
}

export function telemetryResultForError(error: unknown): TelemetryResult {
  if (error instanceof UserAbortError) {
    return { outcome: "abort", exitCode: EXIT_CODE.SUCCESS };
  }
  if (error instanceof CliError) {
    return { outcome: "error", exitCode: error.exitCode, errorCode: error.code ?? "cli_error" };
  }
  if (error instanceof ApiError) {
    return { outcome: "error", exitCode: EXIT_CODE.GENERAL, errorCode: error.code ?? "api_error" };
  }
  return { outcome: "error", exitCode: EXIT_CODE.GENERAL, errorCode: "unexpected_error" };
}

/**
 * Build + send the event, and surface the one-time disclosure notice.
 * Awaited by runProgram before process.exit; must never throw or exceed
 * `deadlineMs` by more than scheduling noise. The deadline covers the entire
 * job — config I/O, git profile lookup, and the POST — not just the fetch;
 * on timeout the event is dropped (`deadlineMs` is overridden in tests).
 *
 * Callable twice per run — once normally, once from the SIGINT handler — and
 * emits at most one event across both. The one case a run is still reported as
 * a success it did not have is a Ctrl-C in the bookkeeping tail *after* the
 * POST has already landed: that event cannot be retracted, and sending a second
 * would double-count the run.
 */
export async function finalizeAndSendTelemetry(
  result: TelemetryResult,
  deadlineMs: number = TELEMETRY_TIMEOUT_MS,
  outlivesInterrupt = false,
): Promise<void> {
  if (finalized || !context) return;

  // A copy, not the live context: the send awaits config reads before it
  // builds the event, and a deploy read still in flight when the command
  // failed could land in that window. The event says what was known when
  // the command ended, whatever finishes afterwards.
  const current = { ...context, components: { ...context.components } };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const work = buildAndSend(current, result, controller.signal, outlivesInterrupt)
      .then(() => {
        // Reached the endpoint, or decided nothing would be sent at all. Either
        // way the run is accounted for and no later flush reports it again.
        finalized = true;
        context = null;
      })
      .catch((error: unknown) => {
        // Aborted or failed. The context stays put so the shutdown flush can
        // report the interrupt that most likely caused this.
        log.debug(`telemetry: send failed: ${error}`);
      });
    await Promise.race([work, abortedToResolved(controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

async function abortedToResolved(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function buildAndSend(
  current: TelemetryContext,
  result: TelemetryResult,
  signal: AbortSignal,
  outlivesInterrupt: boolean,
): Promise<void> {
  // Re-checked here (not just at start) so `clerk telemetry disable` itself
  // sees the freshly persisted opt-out and sends nothing.
  if (!(await getTelemetryStatus()).enabled) return;

  // The notice tells the user "Nothing has been sent during this run" — honor it.
  if (await maybeShowTelemetryNotice()) return;

  const machineUuid = await ensureMachineUuid();
  const resolved = await resolveProfile(process.cwd()).catch(() => undefined);

  const event = {
    sdk: "clerk-cli",
    sdkv: CURRENT_VERSION,
    event: "CLI_COMMAND_EXECUTED",
    payload: {
      command: current.command,
      flags: current.flags,
      outcome: result.outcome,
      exit_code: result.exitCode,
      error_code: result.errorCode ?? null,
      // `stage` is shared (init, login and deploy each write their own group).
      // `pause_step` and `components` are deploy's and ride on every other
      // command's event as null members. They sit at the top level because the
      // warehouse staging model already reads these exact paths (as of
      // data-platform#604), so nesting them under a per-command key now would
      // cost a warehouse change for no visible gain. That is a cost call, not
      // a shape to copy: a command that needs its own structured detail can
      // still add a namespaced object, with a contract-test arm to match.
      stage: current.stage,
      pause_step: current.pauseStep,
      // Nested rather than four flat keys: it is one JSON path per component
      // in the warehouse, and the group is obviously one thing. A null member
      // means never observed — see TelemetryComponents.
      components: current.components,
      duration_ms: Date.now() - current.startedAt,
      machine_uuid: machineUuid,
      install_method: detectInstallMethod(process.env, process.execPath),
      ai_agent: detectAiAgent(process.env),
      terminal_program: detectTerminalProgram(process.env),
      mode: getMode(),
      os: process.platform,
      arch: process.arch,
      ci: Boolean(process.env.CI),
      in_tmux: detectInTmux(process.env),
      in_screen: detectInScreen(process.env),
      env: getCurrentEnvName(),
      workspace_id: resolved?.profile.workspaceId ?? null,
      app_id: resolved?.profile.appId ?? null,
    },
  };

  log.debug(`telemetry: event ${JSON.stringify(event)}`);

  const url = process.env.CLERK_TELEMETRY_URL ?? DEFAULT_TELEMETRY_ENDPOINT;
  await loggedFetch(url, {
    tag: "telemetry",
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ events: [event] }),
    signal,
    bestEffort: true,
    // Only the shutdown flush reports the interrupt, so only it may outlive
    // one. A normal end-of-command flush must stay interruptible: bypassing
    // the signal there would let a Ctrl-C mid-POST record the run's success
    // event. Being aborted is how it hands the run to the shutdown flush,
    // which finds the context still in place and re-sends it as an abort.
    ignoreInterrupt: outlivesInterrupt,
  });
}

/**
 * One-time stderr disclosure for humans and agents alike. Returns true when
 * the notice was just shown — that run sends nothing, so disclosure always
 * precedes a machine's first event. CI is exempt from both the notice and
 * the grace run: ephemeral CI machines are always on their "first run", so
 * a grace there would mean CI never sends at all.
 */
async function maybeShowTelemetryNotice(): Promise<boolean> {
  if (process.env.CI) return false;
  if (!(await markTelemetryNoticeShown())) return false;
  log.blank();
  log.info(
    "The Clerk CLI collects usage telemetry to help improve the CLI: command name, flag names,",
  );
  log.info(
    "duration, outcome, the step a multi-step command reached, a random machine identifier —",
  );
  log.info("and your workspace and app IDs when a project is linked.");
  log.info("Nothing has been sent during this run.");
  log.info("Opt out: `clerk telemetry disable` — details: https://clerk.com/docs/telemetry");
  log.blank();
  return true;
}
