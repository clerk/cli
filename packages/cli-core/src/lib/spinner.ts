import { Writable } from "node:stream";
import { intro as clackIntro, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import { isHuman } from "../mode.ts";
import { dim, cyan } from "./color.ts";
import { animateHeader } from "./gradient.ts";
import { UserAbortError, isPromptExitError } from "./errors.ts";
import { log, pushPrefix, popPrefix } from "./log.ts";
import { getUiOutput } from "./ui.ts";

const S_BAR = "│";
const S_BAR_END = "└";
const PAUSED_INSTRUCTION = "Run this command again to continue.";

const logUiOutput = new Writable({
  write(chunk, _encoding, callback) {
    log.ui(typeof chunk === "string" ? chunk : chunk.toString("utf8"));
    callback();
  },
});

function getOutput() {
  return getUiOutput() ?? logUiOutput;
}

function writeUi(message: string) {
  const output = getUiOutput();
  if (output) {
    output.write(message);
    return;
  }
  log.ui(message);
}

/** Print intro bracket and arrange for subsequent `log.*` lines to be gutter-prefixed. */
export function intro(title?: string) {
  if (!isHuman()) return;
  clackIntro(title, { output: getOutput() });
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
export async function outro(messageOrSteps?: string | readonly string[]) {
  if (!isHuman()) return;
  popPrefix();

  if (Array.isArray(messageOrSteps)) {
    await animateHeader({ prefix: `${dim(S_BAR_END)}  `, label: "Next steps", fallback: dim });
    for (const step of messageOrSteps) {
      writeUi(`   ${cyan("→")} ${step}\n`);
    }
    writeUi("\n");
    return;
  }

  clackOutro(typeof messageOrSteps === "string" ? messageOrSteps : "Done", {
    output: getOutput(),
  });
}

/** Print a paused outro with the instruction needed to resume later. */
export function pausedOutro(instruction = PAUSED_INSTRUCTION) {
  if (!isHuman()) return;
  popPrefix();
  writeUi(`${dim(S_BAR)}\n`);
  writeUi(`${dim(S_BAR_END)}  Paused\n`);
  writeUi(`   ${cyan("→")} ${instruction}\n\n`);
}

/** Print a bar separator: │ */
export function bar() {
  if (!isHuman()) return;
  writeUi(`${dim(S_BAR)}\n`);
}

export type SpinnerControls = {
  update(message: string): void;
};

/**
 * Controls for commands wrapped by {@link withGutter}.
 */
export type GutterControls = {
  setNextSteps(steps: readonly string[]): void;
};

/**
 * Run a command inside an intro/outro gutter and guarantee the gutter closes.
 */
export async function withGutter<T>(
  title: string,
  fn: (controls: GutterControls) => Promise<T>,
  options?: { skip?: boolean },
): Promise<T> {
  let nextSteps: readonly string[] | undefined;
  const controls: GutterControls = {
    setNextSteps(steps) {
      nextSteps = steps;
    },
  };

  if (options?.skip || !isHuman()) return fn(controls);

  intro(title);
  try {
    const result = await fn(controls);
    outro(nextSteps);
    return result;
  } catch (error) {
    if (error instanceof UserAbortError || isPromptExitError(error)) {
      pausedOutro();
    } else {
      outro("Failed");
    }
    throw error;
  }
}

export async function withSpinner<T>(
  message: string,
  fn: (controls: SpinnerControls) => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  if (!isHuman()) return fn({ update: () => {} });

  const s = clackSpinner({ output: getOutput() });
  s.start(message);
  try {
    const result = await fn({ update: (nextMessage) => s.message(nextMessage) });
    s.stop(doneMessage ?? message.replace(/\.{3}$/, ""));
    return result;
  } catch (error) {
    s.error("Failed");
    throw error;
  }
}
