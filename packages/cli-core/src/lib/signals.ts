/**
 * Ctrl-C handling.
 *
 * The exit code depends on what the CLI was doing when the interrupt arrived:
 * waiting on the user or on a timer is a clean exit (0), because the user
 * changed their mind; anything else was an operation in progress and exits 130.
 *
 * Everything is work unless it says otherwise — only the wait seams call
 * {@link whileWaiting}, so nothing else has to be annotated.
 */

import { EXIT_CODE } from "./errors.ts";
import { log } from "./log.ts";

/** Telemetry budget on Ctrl-C — the user wants their shell back. */
const INTERRUPT_FLUSH_MS = 250;

const controller = new AbortController();

/**
 * Threaded into every abortable primitive (`loggedFetch`, `sleep`) and aborted
 * only by {@link CLI_SIGINT_HANDLER}, so in-flight work stops when the user
 * interrupts rather than when the process finally dies.
 */
export const interruptSignal: AbortSignal = controller.signal;

let waits = 0;
let interrupted: number | null = null;

/**
 * Wrap a stretch of time spent waiting on the user or on a timer. Ctrl-C during
 * one of these exits 0; everything not wrapped exits 130.
 *
 * Prompts and pickers deliberately do not need this: clack holds stdin in raw
 * mode, so no SIGINT is delivered at all and cancelling one already surfaces as
 * a `UserAbortError`.
 */
export async function whileWaiting<T>(work: Promise<T>): Promise<T> {
  waits++;
  try {
    return await work;
  } finally {
    waits--;
  }
}

/** The code a Ctrl-C settled on, or null if none has arrived. */
export const interruptedExitCode = (): number | null => interrupted;

/**
 * Record that a Ctrl-C arrived and latch the code it settled on. Called by the
 * handler below and by `webhooks listen`, which does its own graceful drain.
 */
export function beginInterrupt(): number {
  interrupted ??= waits > 0 ? EXIT_CODE.SUCCESS : EXIT_CODE.SIGINT;
  return interrupted;
}

/**
 * Exit with `code`. For 130 that means *dying from SIGINT* rather than exiting
 * 130: only a real signal death sets `WIFSIGNALED`, which is what a wrapping
 * shell script inspects to decide whether to stop. `process.exit(130)` sets
 * `WIFEXITED` instead and the script keeps going.
 *
 * Only re-raises once {@link beginInterrupt} has run — you may only claim to
 * die from a signal you actually received, and `process.kill` is real even
 * under a test harness that stubs `process.exit`.
 *
 * Windows' default SIGINT action exits 3 rather than following the 128+N
 * convention, and clerk.exe is a release target, so it plain-exits there.
 */
export function exitInterrupted(code: number): never {
  // `return` rather than a bare call: tests stub `process.exit` with a no-op,
  // and falling through to `process.kill` below would take the runner down for
  // real. Nothing after this line may run unless we mean to die by signal.
  if (
    code !== EXIT_CODE.SIGINT ||
    interrupted === null ||
    process.platform === "win32" ||
    process.env.NODE_ENV === "test"
  ) {
    return process.exit(code);
  }
  process.removeAllListeners("SIGINT"); // restore the default disposition
  process.kill(process.pid, "SIGINT");
  return process.exit(EXIT_CODE.SIGINT); // unreachable in practice; keeps the `never`
}

/**
 * The CLI's SIGINT handler. Named (not an inline arrow) so `webhooks listen`
 * can `process.removeListener("SIGINT", CLI_SIGINT_HANDLER)` and install its own
 * graceful-drain handling without disturbing anything else.
 *
 * Async on purpose: awaiting the telemetry flush keeps the event loop alive
 * long enough to report the interrupted run, which `process.exit` from a
 * synchronous handler never could. A second Ctrl-C during that window quits
 * immediately.
 */
export const CLI_SIGINT_HANDLER = async (): Promise<void> => {
  if (interrupted !== null) exitInterrupted(interrupted);
  const code = beginInterrupt();
  controller.abort();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  log.ui("\x1b[?25h"); // clack's block() hid the cursor and its cleanup will not run
  // Imported lazily so this module stays a leaf. `loggedFetch` needs
  // `interruptSignal`, so a static import here would be a cycle, and it would
  // drag telemetry's whole dependency tree into everything that handles signals.
  const { finalizeAndSendTelemetry } = await import("./telemetry.ts");
  await finalizeAndSendTelemetry({ outcome: "abort", exitCode: code }, INTERRUPT_FLUSH_MS);
  exitInterrupted(code);
};

/** Test-only: clear the latched interrupt between cases. */
export function _resetInterruptState(): void {
  waits = 0;
  interrupted = null;
}
