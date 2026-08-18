import { setTimeout as delay } from "node:timers/promises";
import { interruptSignal } from "./signals.ts";

/**
 * Interruptible delay. Rejects with an `AbortError` on Ctrl-C, so a caller
 * stops at the next backoff rather than serving out a 48-second wait.
 *
 * Deliberately **not** wrapped in `whileAwaitingUser`: every sleep in this CLI
 * is a step inside an operation — a retry backoff or a poll interval — not the
 * CLI sitting idle. Classifying it as idle made `clerk deploy status --wait`
 * exit 0 when interrupted mid-countdown, and that command's exit code is what
 * a script reads as "the deploy is complete".
 */
export function sleep(ms: number): Promise<void> {
  return delay(ms, undefined, { signal: interruptSignal() });
}
