import { isHuman } from "../mode.ts";
import { dim, cyan, green, red } from "./color.ts";
import { log, pushPrefix, popPrefix } from "./log.ts";

const FRAMES = ["◒", "◐", "◓", "◑"];
const INTERVAL = 80;

const S_BAR = "│";
const S_BAR_START = "┌";
const S_BAR_END = "└";
const S_STEP_DONE = "◇";
const S_STEP_ERROR = "■";

const isInteractive = () => process.stderr.isTTY && !process.env.CI;

// --- Public API ---

/** Print intro bracket: ┌  title — prefixes log output with │ until outro(). */
export function intro(title?: string) {
  if (!isHuman()) return;
  const line = title ? `${dim(S_BAR_START)}  ${title}` : dim(S_BAR_START);
  log.ui(`${line}\n`);
  pushPrefix();
}

/**
 * Print outro bracket:
 *
 * ```
 *  │
 *  └  $message
 * ```
 *
 * Then restores normal log output. Pass a string[] to render as next steps
 * after the bracket.
 **/
export function outro(messageOrSteps?: string | readonly string[]) {
  if (!isHuman()) return;
  popPrefix();
  log.ui(`${dim(S_BAR)}\n`);

  if (Array.isArray(messageOrSteps)) {
    log.ui(`${dim(S_BAR_END)}  ${dim("Next steps")}\n`);
    for (const step of messageOrSteps) {
      log.ui(`   ${cyan("→")} ${step}\n`);
    }
    log.ui("\n");
  } else {
    const label = messageOrSteps ?? "Done";
    log.ui(`${dim(S_BAR_END)}  ${label}\n\n`);
  }
}

/** Print a bar separator: │ */
export function bar() {
  if (!isHuman()) return;
  log.ui(`${dim(S_BAR)}\n`);
}

function createSpinner() {
  const interactive = isInteractive();
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;
  let currentMessage = "";

  const render = () => {
    const char = cyan(FRAMES[frame++ % FRAMES.length]!);
    log.ui(`\r\x1b[K${char}  ${currentMessage}`);
  };

  return {
    start(message: string) {
      currentMessage = message;
      if (!interactive) {
        log.ui(`${S_STEP_DONE}  ${message}\n`);
        return;
      }
      log.ui("\x1b[?25l"); // hide cursor
      timer = setInterval(render, INTERVAL);
    },
    update(message: string) {
      currentMessage = message;
      if (interactive) render();
    },
    stop(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (!interactive) return;
      log.ui("\r\x1b[K");
      if (finalMessage) {
        log.ui(`${green(S_STEP_DONE)}  ${finalMessage}\n`);
      }
      log.ui("\x1b[?25h"); // show cursor
    },
    error(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (!interactive) return;
      log.ui("\r\x1b[K");
      log.ui(`${red(S_STEP_ERROR)}  ${finalMessage ?? "Failed"}\n`);
      log.ui("\x1b[?25h");
    },
  };
}

export type SpinnerControls = {
  update(message: string): void;
};

export async function withSpinner<T>(
  message: string,
  fn: (controls: SpinnerControls) => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  if (!isHuman()) return fn({ update: () => {} });

  const s = createSpinner();
  s.start(message);
  try {
    const result = await fn({ update: s.update });
    s.stop(doneMessage ?? message.replace(/\.{3}$/, ""));
    return result;
  } catch (error) {
    s.error("Failed");
    throw error;
  }
}
