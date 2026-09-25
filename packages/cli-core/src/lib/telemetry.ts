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
 * What happened to the command, not to the thing it acted on. `incomplete`
 * means the command answered and the thing it reports on is not finished; only
 * `clerk deploy status` sends it, by declaring it. How far a deploy got is
 * `stage` and `components`, never `outcome`.
 */
export type TelemetryOutcome = "success" | "error" | "abort" | "incomplete";

/**
 * What a command may declare for a nonzero soft exit. Not `success`, which
 * would file a failure as a success, and not `abort`, which the interrupt path
 * reports itself.
 */
export type SoftExitOutcome = "incomplete" | "error";

export type TelemetryResult = {
  outcome: TelemetryOutcome;
  exitCode: number;
  errorCode?: string;
};

/** The step a `clerk deploy` run stopped on when the person has something left to do. */
export type TelemetryPauseStep = "dns" | "oauth";

/**
 * Per-component readiness when the run ended. `null` means never observed,
 * which is not `false`: a failed status read is not a DNS failure.
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
  // `clerk deploy` and `clerk deploy status`: the state of the deploy itself,
  // the value `clerk deploy status` reports, not a control-flow position. A
  // finished deploy is `complete`, never `done`; see commands/deploy/README.md.
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

/** What a command wants recorded for its soft exit. `deploy status` declares no code: nothing was thrown. */
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
export function setTelemetryStage(stage: TelemetryStage | null): void {
  if (context) context.stage = stage;
}

/** Read the stage a caller had set, so a nested flow can hand it back. */
export function currentTelemetryStage(): TelemetryStage | null {
  return context?.stage ?? null;
}

/** Record the step a `clerk deploy` run stopped on. Only for a step the person stopped on. */
export function setTelemetryPauseStep(step: TelemetryPauseStep): void {
  if (context) context.pauseStep = step;
}

/**
 * Record DNS, SSL and email DNS from a successful domain-status read, never the
 * substituted all-pending status or the fresh-run placeholder. Leaves `oauth` alone.
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

/** Record whether every required OAuth provider has production credentials. Leaves the domain components alone. */
export function setTelemetryOAuthComplete(complete: boolean): void {
  if (context) context.components = { ...context.components, oauth: complete };
}

/**
 * Declare how a run that exits nonzero without throwing should be recorded.
 * Last call wins; ignored if the run throws or exits 0. Declare it under the
 * same condition that sets the exit code.
 */
export function declareSoftExitOutcome(outcome: SoftExitOutcome, errorCode?: string): void {
  if (context) context.softExit = { outcome, errorCode };
}

/** How a run that set `process.exitCode` and returned is recorded. A declaration applies only to a nonzero exit. */
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
 * Declare a failure the command caught and reported itself, with the code a
 * throw would have carried. An uncoded `ApiError` is split by status (see
 * {@link uncodedApiErrorCode}); thrown ones keep `api_error`. `userSuppliedPath`
 * says who wrote the request path, which decides whether an uncoded 404 is the
 * person's or the CLI's. Never pass a `UserAbortError`: it would be recorded as
 * `unexpected_error`.
 */
export function declareSoftExitError(error: unknown, options: { userSuppliedPath: boolean }): void {
  const code =
    error instanceof ApiError
      ? (error.code ?? uncodedApiErrorCode(error.status, options.userSuppliedPath))
      : (telemetryResultForError(error).errorCode ?? "unexpected_error");
  declareSoftExitOutcome("error", code);
}

/**
 * The code for an API response with no Clerk error code, from its status alone:
 * - 429: `api_rate_limited`, kept apart from `too_many_requests`, which Clerk's
 *   own error body names; an uncoded 429's origin is unknown.
 * - 404: `api_not_found` on a path the person typed, `cli_endpoint_not_found`
 *   on one the CLI built (a stale catalog, a dropped route, or a proxy).
 * - other 4xx: `api_client_error`.
 * - anything else: `api_error`.
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
    // Exit 130 is Ctrl-C (a cancelled deploy prompt), the same keypress the
    // interrupt path records as an abort; the code still says which.
    const outcome = error.exitCode === EXIT_CODE.SIGINT ? "abort" : "error";
    return { outcome, exitCode: error.exitCode, errorCode: error.code ?? "cli_error" };
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

  // A copy, so a read that finishes after the command ended cannot change
  // the event while the send is still building it.
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
      // `pause_step` and `components` are deploy's; null on other commands.
      stage: current.stage,
      pause_step: current.pauseStep,
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
