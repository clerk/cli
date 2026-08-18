/**
 * Ctrl-C handling.
 *
 * The exit code depends on what the CLI was doing when the interrupt arrived:
 * only *waiting on a human* is a clean exit (0), because nothing was in
 * progress to lose. Everything else — a request, a timer, a poll interval, the
 * bookkeeping tail after the command's output is on screen — is an operation,
 * and exits 130.
 *
 * Everything is work unless it says otherwise; the two human-wait seams call
 * {@link whileAwaitingUser}. A timer is deliberately *not* one of them: a poll
 * loop that sleeps between requests is still an operation in progress, and
 * classifying its sleep as idle made `clerk deploy status` report a deploy as
 * complete when the user interrupted it mid-countdown.
 */

import { setMaxListeners } from "node:events";

import { EXIT_CODE, UserAbortError } from "./errors.ts";
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

/**
 * Every `loggedFetch` that brings its own signal composes it with this one via
 * `AbortSignal.any`, which registers a listener here that only clears when the
 * derived signal is collected. `webhooks forward` passes a per-delivery
 * `AbortSignal.timeout` and deliveries run concurrently, so a burst would trip
 * the default max-listeners warning. Unbounded observers are the design here,
 * so say so rather than leaking a warning to the user.
 */
function newInterruptController(): AbortController {
  const next = new AbortController();
  setMaxListeners(0, next.signal);
  return next;
}

let controller = newInterruptController();
let waits = 0;
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
 * Wrap a stretch of time the CLI spends doing nothing but waiting on a human —
 * the browser sign-in round-trip and the `$EDITOR` round-trip. Ctrl-C during
 * one of these exits 0; everything not wrapped is work, and exits 130.
 *
 * Named for the human on purpose. The predecessor was called `whileWaiting`,
 * and `sleep()` read as an obvious "wait" and got wrapped — which is how a poll
 * loop came to report success when it was interrupted. If the thing being
 * awaited is a timer or a request rather than a person, it does not belong
 * here.
 *
 * Prompts and pickers deliberately do not need this: clack holds stdin in raw
 * mode, so no SIGINT is delivered at all and cancelling one already surfaces as
 * a `UserAbortError`.
 */
export async function whileAwaitingUser<T>(work: Promise<T>): Promise<T> {
  waits++;
  try {
    return await work;
  } finally {
    waits--;
  }
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

/** A cancelled run is not a failed one, whether the user cancelled a prompt or pressed Ctrl-C. */
export function isCancelled(error: unknown): boolean {
  return error instanceof UserAbortError || interruptedExitCode() !== null;
}

/**
 * How a command's gutter should close when `error` escaped it.
 *
 * Shared so the command wrappers agree with `withSpinner` on what counts as a
 * cancellation. Checking only `UserAbortError` would render "Failed" on Ctrl-C:
 * an interrupt aborts the in-flight request, which rejects with `AbortError`,
 * not `UserAbortError`.
 *
 * Lives here rather than beside the outro helpers because this is interrupt
 * state, not rendering — and `spinner.ts` is stubbed by many command tests,
 * which would leave every consumer mocking a predicate they do not care about.
 */
export function closeStatusForError(error: unknown): "paused" | "failed" {
  return isCancelled(error) ? "paused" : "failed";
}

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
 * Report the interrupted run, then exit by the route `code` calls for.
 *
 * The single owner of that ordering. `webhooks listen` handles its own Ctrl-C
 * so it can drain in-flight forwards first, and before this existed it reached
 * `exitInterrupted` directly — leaving the one command most likely to actually
 * receive a SIGINT as the one that never reported it.
 *
 * `finalizeAndSendTelemetry` is imported lazily so this module stays a leaf.
 * `loggedFetch` needs `interruptSignal`, so a static import would be a cycle,
 * and it would drag telemetry's whole dependency tree into everything that
 * handles signals.
 */
export async function reportAndExitInterrupted(code: number): Promise<never> {
  const { finalizeAndSendTelemetry } = await import("./telemetry.ts");
  // `true`: this is the shutdown flush, the one send that reports the very
  // interrupt that triggered it, so it must not be aborted by that interrupt.
  await finalizeAndSendTelemetry({ outcome: "abort", exitCode: code }, INTERRUPT_FLUSH_MS, true);
  return exitInterrupted(code);
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
  if (interrupted !== null) return exitInterrupted(interrupted);
  const code = beginInterrupt();
  abortInFlight();
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
  // clack's block() hid the cursor and its cleanup will not run. Only worth
  // emitting to a terminal; in a pipe or CI log it is just noise.
  if (process.stderr.isTTY) log.ui("\x1b[?25h");
  await reportAndExitInterrupted(code);
};

/** Test-only: clear every latch, including the controller the signal comes from. */
export function _resetInterruptState(): void {
  controller = newInterruptController();
  waits = 0;
  interrupted = null;
}
