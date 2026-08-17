/**
 * Ctrl-C handling.
 *
 * The exit code depends on what the CLI was doing when the interrupt arrived:
 * waiting on the user or on a timer is a clean exit (0), because the user
 * changed their mind; anything else was an operation in progress and exits 130.
 *
 * Everything is work unless it says otherwise — the wait seams call
 * {@link whileWaiting}, and once the command's own action has finished
 * {@link markCommandComplete} makes the bookkeeping tail count as a wait too.
 */

import { EXIT_CODE } from "./errors.ts";
import { log } from "./log.ts";

/** Telemetry budget on Ctrl-C — the user wants their shell back. */
const INTERRUPT_FLUSH_MS = 250;

/**
 * Set by tests that need `exitInterrupted` to stay observable. Re-raising is a
 * real `process.kill`, which a stubbed `process.exit` cannot intercept, so a
 * test that reaches it would take the runner down. Deliberately CLI-namespaced:
 * keying this off `NODE_ENV` would let any ambient `NODE_ENV=test` silently
 * disable the signal-death contract for a real user.
 */
const NO_RERAISE_ENV = "CLERK_CLI_NO_SIGNAL_RERAISE";

let controller = new AbortController();
let waits = 0;
let commandComplete = false;
let interrupted: number | null = null;

/**
 * Threaded into every abortable primitive (`loggedFetch`, `sleep`) and aborted
 * only by {@link CLI_SIGINT_HANDLER}, so in-flight work stops when the user
 * interrupts rather than when the process finally dies.
 *
 * A function, not a value: `_resetInterruptState` swaps the controller between
 * tests, and a captured `const` would hand out a permanently-aborted signal.
 */
export function interruptSignal(): AbortSignal {
  return controller.signal;
}

/**
 * Wrap a stretch of time spent waiting on the user or on a timer. Ctrl-C during
 * one of these exits 0; everything not wrapped is work, and exits 130.
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

/**
 * The command's own action has finished; everything after this point is the
 * CLI's bookkeeping tail — the update check and the telemetry flush. Ctrl-C
 * there must not report a failed operation, because the operation succeeded and
 * its output is already on screen. Without this, interrupting that tail kills
 * the CLI with a signal and halts any script wrapping it.
 */
export function markCommandComplete(): void {
  commandComplete = true;
}

/**
 * Cancel everything holding {@link interruptSignal}, so in-flight requests stop
 * when the user interrupts rather than when the process finally dies.
 *
 * Not called by `webhooks listen`: its Ctrl-C path drains in-flight webhook
 * forwards, and aborting them is precisely what the drain exists to avoid.
 */
export function abortInFlight(): void {
  controller.abort();
}

/** The code a Ctrl-C settled on, or null if none has arrived. */
export const interruptedExitCode = (): number | null => interrupted;

/**
 * Record that a Ctrl-C arrived and latch the code it settled on. Called by the
 * handler below and by `webhooks listen`, which does its own graceful drain.
 */
export function beginInterrupt(): number {
  interrupted ??= waits > 0 || commandComplete ? EXIT_CODE.SUCCESS : EXIT_CODE.SIGINT;
  return interrupted;
}

/**
 * Exit with `code`. For 130 that means *dying from SIGINT* rather than exiting
 * 130: only a real signal death sets `WIFSIGNALED`, which is what a wrapping
 * shell script inspects to decide whether to stop. `process.exit(130)` sets
 * `WIFEXITED` instead and the script keeps going.
 *
 * Only re-raises once {@link beginInterrupt} has run — you may only claim to
 * die from a signal you actually received.
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
    process.env[NO_RERAISE_ENV]
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
  abortInFlight();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  // clack's block() hid the cursor and its cleanup will not run. Only worth
  // emitting to a terminal; in a pipe or CI log it is just noise.
  if (process.stderr.isTTY) log.ui("\x1b[?25h");
  // Imported lazily so this module stays a leaf. `loggedFetch` needs
  // `interruptSignal`, so a static import here would be a cycle, and it would
  // drag telemetry's whole dependency tree into everything that handles signals.
  const { finalizeAndSendTelemetry } = await import("./telemetry.ts");
  await finalizeAndSendTelemetry({ outcome: "abort", exitCode: code }, INTERRUPT_FLUSH_MS);
  exitInterrupted(code);
};

/** Test-only: clear every latch, including the controller the signal comes from. */
export function _resetInterruptState(): void {
  controller = new AbortController();
  waits = 0;
  commandComplete = false;
  interrupted = null;
}
