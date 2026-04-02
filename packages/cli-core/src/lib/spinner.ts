import { isHuman } from "../mode.ts";

const FRAMES = ["◒", "◐", "◓", "◑"];
const INTERVAL = 80;

function createSpinner(stream: NodeJS.WriteStream = process.stderr) {
  const isInteractive = stream.isTTY && !process.env.CI;
  let timer: ReturnType<typeof setInterval> | undefined;
  let frame = 0;

  return {
    start(message: string) {
      if (!isInteractive) {
        stream.write(`${message}\n`);
        return;
      }
      stream.write("\x1b[?25l"); // hide cursor
      timer = setInterval(() => {
        const spinner = `\x1b[36m${FRAMES[frame++ % FRAMES.length]}\x1b[0m`;
        stream.write(`\r\x1b[K${spinner} ${message}`);
      }, INTERVAL);
    },
    stop(finalMessage?: string) {
      if (timer) {
        clearInterval(timer);
        timer = undefined;
      }
      if (!isInteractive) return;
      stream.write(`\r\x1b[K`); // clear line
      if (finalMessage) {
        stream.write(`${finalMessage}\n`);
      }
      stream.write("\x1b[?25h"); // show cursor
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
    s.stop("Failed");
    throw error;
  }
}
