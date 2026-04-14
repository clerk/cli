/**
 * Logger collaborator.
 *
 * Wraps the module-level `log` from `lib/log.ts` so commands can route output
 * through `deps.log.*` instead of touching `console` or the module logger
 * directly. This is the seam that lets tests assert on logged messages
 * without spying on the global `console` object.
 *
 * The interface mirrors the module logger's public API so `deps.log` is a
 * drop-in replacement. `log.data` writes to stdout (pipeable); every other
 * method writes to stderr. `log.withTag` is intentionally omitted — tagged
 * child loggers complicate mocking and have no consumers yet.
 *
 * Note: `spinner.intro` patches `console.log`/`console.error` while a flow
 * is active. Calls through `logger` go through the module `log`, which
 * goes through those patched streams, which is the intended behavior (the
 * message is rendered inside the bracketed flow).
 */

import { log } from "./log.ts";

export interface Logger {
  /** Informational message to stderr. */
  info(message: string): void;
  /** Success message to stderr (green). */
  success(message: string): void;
  /** Warning to stderr (yellow). */
  warn(message: string): void;
  /** Error to stderr (red, auto-prefixed "error:"). */
  error(message: string): void;
  /** Debug message to stderr (dim). Only shown when log level is "debug". */
  debug(message: string): void;
  /** Pipeable output to stdout. */
  data(message: string): void;
  /** Raw stderr write — no color, prefix, or throttle. For agent-mode JSON. */
  raw(message: string): void;
  /** Blank line to stderr (preserves pipe prefix inside intro/outro flow). */
  blank(): void;
}

export function createLogger(): Logger {
  return {
    info: (message) => log.info(message),
    success: (message) => log.success(message),
    warn: (message) => log.warn(message),
    error: (message) => log.error(message),
    debug: (message) => log.debug(message),
    data: (message) => log.data(message),
    raw: (message) => log.raw(message),
    blank: () => log.blank(),
  };
}
