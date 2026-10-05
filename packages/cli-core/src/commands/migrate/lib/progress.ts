/**
 * The progress display for the import and undo loops: a bar on one line, the
 * counts on the next.
 *
 * Used instead of a spinner on purpose. A clack spinner puts stdin in raw mode
 * and calls `process.exit(0)` on Ctrl-C, so an interrupted import looked like
 * a finished one and `clerk migrate import … && rm -rf <export>` carried on.
 * This leaves stdin alone: Ctrl-C reaches the CLI's handler, in-flight
 * requests abort, and the process exits 130 (`.claude/rules/interrupts.md`).
 */

import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { isHuman } from "../../../mode.ts";

export type ProgressCounts = { done: number; ok: number; failed: number };

/** Receives the counts as each user finishes. */
export type ProgressUpdate = (counts: ProgressCounts) => void;

type ProgressLine = {
  total: number;
  /** What happened to the users counted in `ok`: "created", "deleted". */
  verb: string;
  counts: ProgressCounts;
  elapsedMs: number;
  /** Terminal columns; the bar fills the line up to 80. */
  columns?: number;
};

const MAX_WIDTH = 80;
/** No estimate until there is this much of a rate to go on. */
const ESTIMATE_AFTER_MS = 2000;
/** At most one redraw per this many ms: an import can report 100 users a second. */
const REDRAW_MS = 100;

const GUTTER = "│  ";
const number = (value: number) => value.toLocaleString("en-US");

/** `~9s`, `~1m 30s`, `~15m`, `~2h 5m`. */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 60) return `~${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest ? `~${minutes}m ${rest}s` : `~${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `~${hours}h ${rest}m` : `~${hours}h`;
}

/** The bar line and the report line, without color. */
export function formatProgress(line: ProgressLine): [string, string] {
  const { total, verb, counts, elapsedMs } = line;
  const width = Math.min(MAX_WIDTH, line.columns ?? MAX_WIDTH);
  const fraction = total > 0 ? Math.min(1, counts.done / total) : 1;

  // Floored, so the bar reads full only when every user is done.
  const percent = `${Math.floor(fraction * 100)}%`.padStart(4);
  const cells = Math.max(10, width - GUTTER.length - 1 - percent.length);
  const filled = Math.floor(cells * fraction);
  const bar = `${GUTTER}${"█".repeat(filled)}${"░".repeat(cells - filled)} ${percent}`;

  const parts = [
    `${number(counts.done)}/${number(total)} users`,
    `✓ ${number(counts.ok)} ${verb}`,
    `✗ ${number(counts.failed)} failed`,
  ];
  if (elapsedMs >= ESTIMATE_AFTER_MS && counts.done > 0 && counts.done < total) {
    parts.push(`${formatRemaining(((total - counts.done) * elapsedMs) / counts.done)} left`);
  }
  return [bar, `${GUTTER}${parts.join("  ·  ")}`];
}

/**
 * Runs `fn` with a progress display for `total` users.
 *
 * At a terminal, the two lines redraw in place. When stderr is not a terminal
 * (a log file, CI), the report line is printed at each 10% instead. An agent
 * gets nothing, as it got nothing from the spinner.
 */
export async function withProgress<T>(
  options: { total: number; verb: string },
  fn: (update: ProgressUpdate) => Promise<T>,
): Promise<T> {
  if (!isHuman()) return fn(() => {});

  const tty = Boolean(process.stderr.isTTY);
  const started = Date.now();
  let counts: ProgressCounts = { done: 0, ok: 0, failed: 0 };
  let drawn = false;
  let lastDraw = 0;
  let lastTenth = -1;

  const draw = (force: boolean) => {
    const now = Date.now();
    const [bar, report] = formatProgress({
      ...options,
      counts,
      elapsedMs: now - started,
      ...(process.stderr.columns ? { columns: process.stderr.columns } : {}),
    });

    if (!tty) {
      const tenth = Math.floor((counts.done / Math.max(1, options.total)) * 10);
      if (!force && tenth === lastTenth) return;
      lastTenth = tenth;
      log.ui(`${report}\n`);
      return;
    }

    if (!force && now - lastDraw < REDRAW_MS) return;
    lastDraw = now;
    // Up over the two lines drawn last time, then clear and rewrite each.
    const up = drawn ? "\x1b[2A" : "";
    // The gutter in the gray clack draws it in.
    const gutter = (line: string) => `${dim("│")}${line.slice(1)}`;
    log.ui(`${up}\r\x1b[2K${gutter(bar)}\n\x1b[2K${gutter(report)}\n`);
    drawn = true;
  };

  draw(true);
  const result = await fn((next) => {
    counts = next;
    draw(false);
  });
  draw(true);
  return result;
}
