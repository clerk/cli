import { isHuman } from "../mode.ts";

const FRAMES = ["◒", "◐", "◓", "◑"];
const INTERVAL = 80;

const S_BAR = "│";
const S_BAR_START = "┌";
const S_BAR_END = "└";
const S_STEP_DONE = "◇";
const S_STEP_ERROR = "■";

const dim = (s: string) => `\x1b[2m${s}\x1b[0m`;
const cyan = (s: string) => `\x1b[36m${s}\x1b[0m`;
const green = (s: string) => `\x1b[32m${s}\x1b[0m`;
const red = (s: string) => `\x1b[31m${s}\x1b[0m`;

const stream = process.stderr;
const isInteractive = () => stream.isTTY && !process.env.CI;

/** Print intro bracket: ┌  title */
export function intro(title?: string) {
  if (!isHuman()) return;
  const line = title ? `${dim(S_BAR_START)}  ${title}` : dim(S_BAR_START);
  stream.write(`${line}\n`);
}

/** Print outro bracket: └  message */
export function outro(message?: string) {
  if (!isHuman()) return;
  stream.write(`${dim(S_BAR)}\n`);
  const line = message ? `${dim(S_BAR_END)}  ${message}` : dim(S_BAR_END);
  stream.write(`${line}\n\n`);
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
        const char = cyan(FRAMES[frame++ % FRAMES.length]);
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
