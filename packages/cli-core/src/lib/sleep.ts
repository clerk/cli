import { setTimeout as delay } from "node:timers/promises";
import { interruptSignal, whileWaiting } from "./signals.ts";

/**
 * Interruptible delay. Ctrl-C during a sleep is the user declining to keep
 * waiting rather than an interrupted operation, so it exits 0.
 */
export function sleep(ms: number): Promise<void> {
  return whileWaiting(delay(ms, undefined, { signal: interruptSignal() }));
}
