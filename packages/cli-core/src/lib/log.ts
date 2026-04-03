import { AsyncLocalStorage } from "node:async_hooks";
import { dim, red, yellow, green } from "./color.ts";

// ── Pipe prefix state (for intro/outro flow) ──────────────────────────────

const S_BAR = "│";
let prefixDepth = 0;

export function pushPrefix() {
  prefixDepth++;
}

export function popPrefix() {
  prefixDepth = Math.max(0, prefixDepth - 1);
}

function applyPrefix(msg: string): string {
  if (prefixDepth === 0) return msg;
  const bar = dim(S_BAR);
  if (!msg) return bar;
  return msg
    .split("\n")
    .map((line) => `${bar}  ${line}`)
    .join("\n");
}

// ── Capture context (for testing) ─────────────────────────────────────────

export type CapturedLogs = {
  stdout: string[];
  stderr: string[];
};

const captureStorage = new AsyncLocalStorage<CapturedLogs>();

export function withCapturedLogs<T>(captured: CapturedLogs, fn: () => T): T {
  return captureStorage.run(captured, fn);
}

function writeln(stream: NodeJS.WriteStream, channel: "stdout" | "stderr", msg: string) {
  const captured = captureStorage.getStore();
  if (captured) {
    captured[channel].push(msg);
  } else {
    stream.write(msg + "\n");
  }
}

// ── Public API ────────────────────────────────────────────────────────────

export const log = {
  /** Informational message to stderr (neutral, no error styling). */
  info(msg: string) {
    writeln(process.stderr, "stderr", applyPrefix(msg));
  },
  /** Success message to stderr (green). */
  success(msg: string) {
    writeln(process.stderr, "stderr", applyPrefix(green(msg)));
  },
  /** Warning to stderr (yellow). */
  warn(msg: string) {
    writeln(process.stderr, "stderr", applyPrefix(yellow(msg)));
  },
  /** Error to stderr (red, prefixed with "error: "). */
  error(msg: string) {
    writeln(process.stderr, "stderr", applyPrefix(red(`error: ${msg}`)));
  },
  /** Blank line to stderr. */
  blank() {
    const captured = captureStorage.getStore();
    if (captured) {
      captured.stderr.push("");
    } else {
      process.stderr.write("\n");
    }
  },
  /** Raw stderr — no color, no prefix. For machine-readable output (agent JSON). */
  raw(msg: string) {
    writeln(process.stderr, "stderr", msg);
  },
  /** Primary data output to stdout (pipeable, never prefixed). */
  data(msg: string) {
    writeln(process.stdout, "stdout", msg);
  },
};
