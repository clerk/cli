import { type EnvLike, isCodexEnv } from "./lib/env-signals.ts";

export type Mode = "human" | "agent";

let forcedMode: Mode | undefined;

/**
 * Set the mode explicitly (from --mode flag or CLERK_MODE env var).
 */
export function setMode(mode: Mode) {
  forcedMode = mode;
}

/** Clears the mode set by `setMode()`. Test-only: lets each test start unforced. */
export function _resetMode(): void {
  forcedMode = undefined;
}

/**
 * Pure mode decision, in priority order:
 * 1. `forced` (from `--mode`)
 * 2. `CLERK_MODE` env var
 * 3. Codex markers → agent. Codex gives every command a pseudo-terminal, so
 *    the TTY check below would read it as a human and block on prompts no one
 *    can answer. Other agents are not consulted here: Claude Code already runs
 *    without a TTY, and Gemini/Cline let a person type into the terminal, so
 *    agent mode would only remove confirmations they could have given.
 * 4. TTY → human, otherwise agent.
 */
export function resolveMode({
  forced,
  env,
  isTTY,
}: {
  forced: Mode | undefined;
  env: EnvLike;
  isTTY: boolean;
}): Mode {
  if (forced) return forced;

  const envMode = env.CLERK_MODE;
  if (envMode === "human" || envMode === "agent") return envMode;

  if (isCodexEnv(env)) return "agent";

  return isTTY ? "human" : "agent";
}

/**
 * Returns the current interaction mode. See `resolveMode` for the priority.
 */
export function getMode(): Mode {
  return resolveMode({
    forced: forcedMode,
    env: process.env,
    isTTY: Boolean(process.stdout.isTTY),
  });
}

export function isHuman(): boolean {
  return getMode() === "human";
}

export function isAgent(): boolean {
  return getMode() === "agent";
}
