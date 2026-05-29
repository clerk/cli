import { Writable } from "node:stream";
import { intro as clackIntro, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import { isHuman } from "../mode.ts";
import { dim, cyan } from "./color.ts";
import { log, pushPrefix, popPrefix } from "./log.ts";
import { getUiOutput } from "./ui.ts";

const S_BAR = "│";
const S_BAR_END = "└";

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

/** Print outro bracket; restores normal `log.*` output. Pass a string[] to render next steps. */
export function outro(messageOrSteps?: string | readonly string[]) {
  if (!isHuman()) return;
  popPrefix();

  if (Array.isArray(messageOrSteps)) {
    writeUi(`${dim(S_BAR)}\n`);
    writeUi(`${dim(S_BAR_END)}  ${dim("Next steps")}\n`);
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

/** Print a bar separator: │ */
export function bar() {
  if (!isHuman()) return;
  writeUi(`${dim(S_BAR)}\n`);
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
