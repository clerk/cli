export type Mode = "human" | "agent";

let forcedMode: Mode | undefined;

/**
 * Set the mode explicitly (from --mode flag or CLERK_MODE env var).
 */
export function setMode(mode: Mode) {
  forcedMode = mode;
}

/**
 * Returns the current interaction mode.
 * Priority: forced mode > env var > TTY detection.
 */
export function getMode(): Mode {
  if (forcedMode) return forcedMode;

  const envMode = process.env.CLERK_MODE;
  if (envMode === "human" || envMode === "agent") return envMode;

  return process.stdout.isTTY ? "human" : "agent";
}

export function isHuman(): boolean {
  return getMode() === "human";
}

export function isAgent(): boolean {
  return getMode() === "agent";
}

export interface ModeService {
  getMode(): Mode;
  isHuman(): boolean;
  isAgent(): boolean;
}

export function createModeService(): ModeService {
  return { getMode, isHuman, isAgent };
}
