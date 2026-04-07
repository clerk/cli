import { isHuman } from "../mode.ts";
import { dim, cyan, green, red } from "./color.ts";
import { pushPrefix, popPrefix } from "./log.ts";

const FRAMES = ["◒", "◐", "◓", "◑"];
const INTERVAL = 80;

const S_BAR = "│";
const S_BAR_START = "┌";
const S_BAR_END = "└";
const S_STEP_DONE = "◇";
const S_STEP_ERROR = "■";

const stream = process.stderr;
const isInteractive = () => stream.isTTY && !process.env.CI;

// --- Public API ---

/** Print intro bracket: ┌  title — prefixes log output with │ until outro(). */
export function intro(title?: string) {
  if (!isHuman()) return;
  const line = title ? `${dim(S_BAR_START)}  ${title}` : dim(S_BAR_START);
  stream.write(`${line}\n`);
  pushPrefix();
}

/** Print outro bracket: └  message — restores normal log output.
 *  Pass a string[] to render as next steps after the bracket. */
export function outro(messageOrSteps?: string | readonly string[]) {
  if (!isHuman()) return;
  popPrefix();
  stream.write(`${dim(S_BAR)}\n`);

  if (Array.isArray(messageOrSteps)) {
    stream.write(`${dim(S_BAR_END)}  ${dim("Next steps")}\n`);
    for (const step of messageOrSteps) {
      stream.write(`   ${cyan("\u2192")} ${step}\n`);
    }
    stream.write("\n");
  } else {
    const label = messageOrSteps ?? "Done";
    stream.write(`${dim(S_BAR_END)}  ${label}\n\n`);
  }
}

/** Print a bar separator: │ */
export function bar() {
  if (!isHuman()) return;
  stream.write(`${dim(S_BAR)}\n`);
}

function createSpinner() {
  const interactive = isInteractive();
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;

  return {
    start(message: string) {
      if (!interactive) {
        stream.write(`${S_STEP_DONE}  ${message}\n`);
        return;
      }
      stream.write("\x1b[?25l"); // hide cursor
      timer = setInterval(() => {
        const char = cyan(FRAMES[frame++ % FRAMES.length]!);
        stream.write(`\r\x1b[K${char}  ${message}`);
      }, INTERVAL);
    },
    stop(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (!interactive) return;
      stream.write(`\r\x1b[K`);
      if (finalMessage) {
        stream.write(`${green(S_STEP_DONE)}  ${finalMessage}\n`);
      }
      stream.write("\x1b[?25h"); // show cursor
    },
    error(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (!interactive) return;
      stream.write(`\r\x1b[K`);
      stream.write(`${red(S_STEP_ERROR)}  ${finalMessage ?? "Failed"}\n`);
      stream.write("\x1b[?25h");
    },
  };
}

export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  if (!isHuman()) return fn();

  const s = createSpinner();
  s.start(message);
  try {
    const result = await fn();
    s.stop(doneMessage ?? message.replace(/\.{3}$/, ""));
    return result;
  } catch (error) {
    s.error("Failed");
    throw error;
  }
}

export interface Spinner {
  intro(title?: string): void;
  outro(messageOrSteps?: string | readonly string[]): void;
  bar(): void;
  withSpinner<T>(message: string, fn: () => Promise<T>, doneMessage?: string): Promise<T>;
}

export const spinner: Spinner = {
  intro,
  outro,
  bar,
  withSpinner,
};
