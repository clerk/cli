import { AsyncLocalStorage } from "node:async_hooks";
import { dim, green, red, yellow } from "./color.ts";

// ── Log level ────────────────────────────────────────────────────────────

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_VALUE: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

let currentLevel: LogLevel = "info";

export function setLogLevel(level: LogLevel) {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function isLevelEnabled(level: LogLevel): boolean {
  return LEVEL_VALUE[level] <= LEVEL_VALUE[currentLevel];
}

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

// ── Spam throttle ────────────────────────────────────────────────────────

const THROTTLE_WINDOW_MS = 1000;
const THROTTLE_MIN = 5;

let lastLogKey = "";
let lastLogCount = 0;
let lastLogTime = 0;
let throttleTimer: ReturnType<typeof setTimeout> | undefined;

function flushThrottle() {
  const repeated = lastLogCount - THROTTLE_MIN;
  // Reset state before writing to avoid re-entering shouldWrite → flushThrottle
  lastLogKey = "";
  lastLogCount = 0;
  throttleTimer = undefined;
  if (repeated > 0) {
    writeln(
      process.stderr,
      "stderr",
      applyPrefix(dim(`  (repeated ${repeated} more time${repeated === 1 ? "" : "s"})`)),
    );
  }
}

/**
 * Returns true if the message should be written, false if throttled.
 */
function shouldWrite(channel: "stdout" | "stderr", msg: string): boolean {
  // Only throttle stderr (UI messages), never stdout (data)
  if (channel === "stdout") return true;
  // Don't throttle in test capture mode
  if (captureStorage.getStore()) return true;

  const key = msg;
  const now = Date.now();

  if (key === lastLogKey && now - lastLogTime < THROTTLE_WINDOW_MS) {
    lastLogCount++;
    lastLogTime = now;

    // Restart the flush timer
    if (throttleTimer) clearTimeout(throttleTimer);
    throttleTimer = setTimeout(flushThrottle, THROTTLE_WINDOW_MS);

    return lastLogCount <= THROTTLE_MIN;
  }

  // New message — flush any pending throttle summary first
  if (throttleTimer) {
    clearTimeout(throttleTimer);
    flushThrottle();
  }

  lastLogKey = key;
  lastLogCount = 1;
  lastLogTime = now;
  return true;
}

// ── Inline highlighting ──────────────────────────────────────────────────

/**
 * Highlights `backtick` spans in cyan within a message.
 */
function highlight(msg: string): string {
  // Use targeted foreground color set/reset (\x1b[39m = default fg) instead of
  // cyan() which uses \x1b[0m (full reset) and kills surrounding styles.
  return msg.replace(/`([^`]+)`/g, (_, content) => `\x1b[36m\`${content}\`\x1b[39m`);
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
    if (!shouldWrite(channel, msg)) return;
    stream.write(msg + "\n");
  }
}

// ── Tagged child logger ──────────────────────────────────────────────────

export type Logger = typeof log & {
  withTag(tag: string): Logger;
};

function createLogger(tag?: string): Logger {
  function formatTag(msg: string): string {
    if (!tag) return msg;
    // Use targeted dim on/off (\x1b[22m = normal intensity) instead of dim()
    // which uses \x1b[0m (full reset) and kills surrounding color styles.
    return `\x1b[2m[${tag}]\x1b[22m ${msg}`;
  }

  const logger = {
    /** Informational message to stderr (neutral, no error styling). */
    info(msg: string) {
      if (!isLevelEnabled("info")) return;
      writeln(process.stderr, "stderr", applyPrefix(highlight(formatTag(msg))));
    },
    /** Success message to stderr (green). */
    success(msg: string) {
      if (!isLevelEnabled("info")) return;
      writeln(process.stderr, "stderr", applyPrefix(green(formatTag(msg))));
    },
    /** Warning to stderr (yellow). */
    warn(msg: string) {
      if (!isLevelEnabled("warn")) return;
      writeln(process.stderr, "stderr", applyPrefix(yellow(formatTag(msg))));
    },
    /** Error to stderr (red, prefixed with "error: "). */
    error(msg: string) {
      if (!isLevelEnabled("error")) return;
      writeln(process.stderr, "stderr", applyPrefix(red(`error: ${formatTag(msg)}`)));
    },
    /** Debug message to stderr (dim). Only shown when log level is "debug". */
    debug(msg: string) {
      if (!isLevelEnabled("debug")) return;
      writeln(process.stderr, "stderr", applyPrefix(dim(formatTag(msg))));
    },
    /** Blank line to stderr. Preserves pipe prefix inside intro/outro flow. */
    blank() {
      const prefix = applyPrefix("");
      const captured = captureStorage.getStore();
      if (captured) {
        captured.stderr.push(prefix);
      } else {
        process.stderr.write(prefix + "\n");
      }
    },
    /** Raw stderr — no color, no prefix, no throttle. For machine-readable output (agent JSON). */
    raw(msg: string) {
      const captured = captureStorage.getStore();
      if (captured) {
        captured.stderr.push(msg);
      } else {
        process.stderr.write(msg + "\n");
      }
    },
    /** Primary data output to stdout (pipeable, never prefixed). */
    data(msg: string) {
      writeln(process.stdout, "stdout", msg);
    },
    /** Create a child logger with a tag prefix. */
    withTag(childTag: string): Logger {
      const combined = tag ? `${tag}:${childTag}` : childTag;
      return createLogger(combined);
    },
  } as Logger;

  return logger;
}

// ── Public API ────────────────────────────────────────────────────────────

export const log: Logger = createLogger();
