import { AsyncLocalStorage } from "node:async_hooks";
import { isHuman } from "../../../mode.ts";
import { getLogLevel } from "../../../lib/log.ts";
import { createSpinner, withSpinner, type SpinnerControls } from "../../../lib/spinner.ts";

export function compactNativeOutput(): boolean {
  return isHuman() && getLogLevel() !== "debug";
}

const progress = new AsyncLocalStorage<{
  message: string;
  spinner?: ReturnType<typeof createSpinner>;
}>();

/** Keep one indicator across sequential checks; always clean up on command exit. */
export async function withNativeProgress<T>(fn: () => Promise<T>): Promise<T> {
  if (!compactNativeOutput()) return fn();
  return progress.run({ message: "Inspecting your project..." }, async () => {
    try {
      return await fn();
    } catch (error) {
      progress.getStore()?.spinner?.fail(error);
      throw error;
    } finally {
      stopNativeProgress();
    }
  });
}

/** Call before displaying a question, preview, or result. */
export function stopNativeProgress(): void {
  const state = progress.getStore();
  state?.spinner?.stop();
  if (state) state.spinner = undefined;
}

/** In compact init, individual checks share the phase's stable label and spinner. */
export async function withNativeSpinner<T>(
  message: string,
  fn: (controls: SpinnerControls) => Promise<T>,
): Promise<T> {
  const state = progress.getStore();
  if (state) {
    state.spinner ??= createSpinner(state.message, null);
    return fn({ update: () => {} });
  }
  return withSpinner(message, fn, compactNativeOutput() ? null : undefined);
}
