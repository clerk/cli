import { isHuman } from "../mode.ts";
import { dim, cyan, green, red } from "./color.ts";

const FRAMES = ["◒", "◐", "◓", "◑"];
const INTERVAL = 80;

const S_BAR = "│";
const S_BAR_START = "┌";
const S_BAR_END = "└";
const S_STEP_DONE = "◇";
const S_STEP_ERROR = "■";

const stream = process.stderr;
const isInteractive = () => stream.isTTY && !process.env.CI;

// --- Console pipe (auto-prefix console.log/error with │ inside intro/outro flow) ---

const _log = console.log;
const _error = console.error;
let flowDepth = 0;

function pipedFn(original: typeof console.log): typeof console.log {
  return (...args: unknown[]) => {
    const msg = args.map((a) => (typeof a === "string" ? a : String(a))).join(" ");
    if (!msg) {
      stream.write(`${dim(S_BAR)}\n`);
      return;
    }
    for (const line of msg.split("\n")) {
      stream.write(`${dim(S_BAR)}  ${line}\n`);
    }
  };
}

function patchConsole() {
  if (flowDepth === 0) {
    console.log = pipedFn(_log);
    console.error = pipedFn(_error);
  }
  flowDepth++;
}

function unpatchConsole() {
  flowDepth = Math.max(0, flowDepth - 1);
  if (flowDepth === 0) {
    console.log = _log;
    console.error = _error;
  }
}

// --- Public API ---

/** Print intro bracket: ┌  title — pipes all console output until outro(). */
export function intro(title?: string) {
  if (!isHuman()) return;
  const line = title ? `${dim(S_BAR_START)}  ${title}` : dim(S_BAR_START);
  stream.write(`${line}\n`);
  patchConsole();
}

/** Print outro bracket: └  message — restores normal console output. */
export function outro(message?: string) {
  if (!isHuman()) return;
  unpatchConsole();
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
