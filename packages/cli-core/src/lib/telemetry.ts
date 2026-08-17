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
import { ApiError, CliError, EXIT_CODE, UserAbortError, isPromptExitError } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";
import { getMode } from "../mode.ts";
import { CURRENT_VERSION, IS_DEV_BUILD } from "./version.ts";

export type TelemetryResult = {
  outcome: "success" | "error" | "abort";
  exitCode: number;
  errorCode?: string;
};

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
};

let context: TelemetryContext | null = null;

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
    };
  } catch (error) {
    log.debug(`telemetry: failed to start context: ${error}`);
  }
}

export function telemetryResultForError(error: unknown): TelemetryResult {
  if (error instanceof UserAbortError || isPromptExitError(error)) {
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
 */
export async function finalizeAndSendTelemetry(
  result: TelemetryResult,
  deadlineMs: number = TELEMETRY_TIMEOUT_MS,
): Promise<void> {
  const current = context;
  context = null;
  if (!current) return;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deadlineMs);
  try {
    const work = buildAndSend(current, result, controller.signal).catch((error: unknown) => {
      log.debug(`telemetry: send failed: ${error}`);
    });
    await Promise.race([work, abortedToResolved(controller.signal)]);
  } finally {
    clearTimeout(timer);
  }
}

function abortedToResolved(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

async function buildAndSend(
  current: TelemetryContext,
  result: TelemetryResult,
  signal: AbortSignal,
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
    "duration, outcome, a random machine identifier — and your workspace and app IDs when a",
  );
  log.info("project is linked. Nothing has been sent during this run.");
  log.info("Opt out: `clerk telemetry disable` — details: https://clerk.com/docs/telemetry");
  log.blank();
  return true;
}
