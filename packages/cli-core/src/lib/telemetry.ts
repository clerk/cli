/**
 * Anonymous per-invocation usage telemetry (GROW-1200).
 *
 * One CLI_COMMAND_EXECUTED event per command run, POSTed to the
 * telemetry-service worker (BigQuery behind it). Opt out with
 * CLERK_TELEMETRY_DISABLED=1 or DO_NOT_TRACK=1. Dev builds send nothing
 * unless CLERK_TELEMETRY_URL overrides the endpoint (test escape hatch).
 *
 * Telemetry must never affect the command: every entry point swallows its
 * own failures to log.debug and the send is capped at TELEMETRY_TIMEOUT_MS.
 */

import { DEFAULT_TELEMETRY_ENDPOINT, TELEMETRY_TIMEOUT_MS } from "./constants.ts";
import { ensureMachineUuid, markTelemetryNoticeShown, resolveProfile } from "./config.ts";
import {
  detectAiAgent,
  detectInScreen,
  detectInstallMethod,
  detectInTmux,
  detectTerminalProgram,
  type EnvLike,
} from "./env-signals.ts";
import { getCurrentEnvName } from "./environment.ts";
import { ApiError, CliError, EXIT_CODE, UserAbortError, isPromptExitError } from "./errors.ts";
import { loggedFetch } from "./fetch.ts";
import { log } from "./log.ts";
import { getMode, isHuman } from "../mode.ts";
import { DEV_CLI_VERSION, resolveCliVersion } from "./version.ts";

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

const isTruthyEnv = (value?: string) => value === "1" || value?.toLowerCase() === "true";

export function telemetryEnabled(
  env: EnvLike = process.env,
  version: string = resolveCliVersion() ?? DEV_CLI_VERSION,
): boolean {
  if (isTruthyEnv(env.CLERK_TELEMETRY_DISABLED)) return false;
  if (isTruthyEnv(env.DO_NOT_TRACK)) return false;
  if (env.CLERK_TELEMETRY_URL) return true;
  return version !== DEV_CLI_VERSION;
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

/** Called from the root preAction hook. Pure in-memory; never throws. */
export function startCommandTelemetry(actionCommand: TelemetryCommand): void {
  try {
    context = {
      command: commandPathOf(actionCommand),
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
 * TELEMETRY_TIMEOUT_MS by more than scheduling noise.
 */
export async function finalizeAndSendTelemetry(result: TelemetryResult): Promise<void> {
  const current = context;
  context = null;
  if (!current || !telemetryEnabled()) return;

  try {
    await maybeShowTelemetryNotice();

    const machineUuid = await ensureMachineUuid();
    const resolved = await resolveProfile(process.cwd()).catch(() => undefined);
    const version = resolveCliVersion() ?? DEV_CLI_VERSION;

    const event = {
      sdk: "clerk-cli",
      sdkv: version,
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

    const url = process.env.CLERK_TELEMETRY_URL ?? DEFAULT_TELEMETRY_ENDPOINT;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TELEMETRY_TIMEOUT_MS);
    try {
      await loggedFetch(url, {
        tag: "telemetry",
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ events: [event] }),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    log.debug(`telemetry: send failed: ${error}`);
  }
}

/** One-time stderr disclosure; human runs outside CI only. Docs cover the rest. */
async function maybeShowTelemetryNotice(): Promise<void> {
  if (!isHuman() || process.env.CI) return;
  if (!(await markTelemetryNoticeShown())) return;
  log.blank();
  log.info("The Clerk CLI collects anonymous usage telemetry to help improve the CLI.");
  log.info(
    "Learn more or opt out: https://clerk.com/docs/telemetry (`CLERK_TELEMETRY_DISABLED=1`)",
  );
  log.blank();
}
