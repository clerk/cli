import { intro as clackIntro, outro as clackOutro, spinner as clackSpinner } from "@clack/prompts";
import { isHuman } from "../mode.ts";
import { dim, cyan } from "./color.ts";
import { pushPrefix, popPrefix } from "./log.ts";
import { getUiOutput } from "./ui.ts";

const S_BAR = "│";
const S_BAR_END = "└";

function writeUi(message: string) {
  (getUiOutput() ?? process.stderr).write(message);
}

/** Print intro bracket and arrange for subsequent `log.*` lines to be gutter-prefixed. */
export function intro(title?: string) {
  if (!isHuman()) return;
  clackIntro(title, { output: getUiOutput() });
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
    output: getUiOutput(),
  });
}

/** Print a bar separator: │ */
export function bar() {
  if (!isHuman()) return;
  writeUi(`${dim(S_BAR)}\n`);
}

export async function withSpinner<T>(
  message: string,
  fn: () => Promise<T>,
  doneMessage?: string,
): Promise<T> {
  if (!isHuman()) return fn();

  const s = clackSpinner({ output: getUiOutput() });
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
