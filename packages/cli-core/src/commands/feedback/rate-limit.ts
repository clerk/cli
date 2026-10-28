/**
 * Per-machine cap on feedback sends: at most FEEDBACK_DAILY_LIMIT in a rolling
 * FEEDBACK_WINDOW_MS, and no second report about the same `command` and
 * `error_code` inside that window (checked only when both are present, so a
 * report about a command that succeeded but did the wrong thing is never
 * collapsed with another).
 *
 * Why this shape and not a per-hour cap: agent-mode errors tend to come from
 * retry loops that hit the same error over and over, and one busy machine can
 * run hundreds of commands an hour, so an hourly cap alone would still admit
 * hundreds of identical reports a day from one machine. The known cost: two
 * distinct problems that share a command and code within a day are collapsed
 * into one report.
 *
 * The record is a JSON file in the cache directory, read-modify-write with
 * the same best-effort stance as the update check's cache file: an unreadable
 * or missing file counts as empty, a failed write is logged at debug level
 * and nothing else. Each write is renamed into place, so a send racing
 * another reads the old record or the new one, never a partial file, which
 * would count as empty and wipe the record. Sends racing each other can
 * still drop one another's entries, so a burst of parallel sends may be
 * undercounted. Every attempted POST is recorded, accepted or not: a send
 * that timed out or was answered with an error may still have landed, and a
 * retry loop against a slow endpoint must still meet the cap. A send the
 * endpoint refused with a 4xx was not stored, so it is recorded with
 * `dailyTotalOnly`: it counts toward the daily total, which keeps a retry
 * loop against a refusing endpoint bounded, but never blocks a repeat. A
 * send refused before any POST (opt-out, cap, a config failure) is not
 * recorded.
 */

import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  CLERK_CACHE_DIR,
  FEEDBACK_DAILY_LIMIT,
  FEEDBACK_SENDS_FILE_NAME,
  FEEDBACK_WINDOW_MS,
} from "../../lib/constants.ts";
import { log } from "../../lib/log.ts";

export type FeedbackSend = {
  /** Epoch milliseconds. */
  sentAt: number;
  command: string | null;
  errorCode: string | null;
  /** The endpoint refused it (4xx), so nothing was stored: counted toward the daily total, never a repeat. */
  dailyTotalOnly?: boolean;
};

export type RateLimitVerdict =
  | { allowed: true }
  | { allowed: false; reason: "daily_limit" | "repeat" };

let overrideDir: string | undefined;

/**
 * Test-only: keep the sends file out of the real cache directory, which the
 * cache-dir constant fixes at module load from the environment. Pass undefined
 * to reset.
 */
export function _setFeedbackCacheDir(dir: string | undefined): void {
  overrideDir = dir;
}

function sendsFile(): string {
  return join(overrideDir ?? CLERK_CACHE_DIR, FEEDBACK_SENDS_FILE_NAME);
}

function isFeedbackSend(value: unknown): value is FeedbackSend {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.sentAt === "number" &&
    (v.command === null || typeof v.command === "string") &&
    (v.errorCode === null || typeof v.errorCode === "string") &&
    (v.dailyTotalOnly === undefined || typeof v.dailyTotalOnly === "boolean")
  );
}

/**
 * Sends inside the window, oldest first; anything unreadable is dropped. The
 * window ends at `now` or at the newest recorded send, whichever is later: a
 * clock that jumped backwards makes recent sends look like the future, and
 * dropping them, or measuring the window from the earlier clock, would wipe
 * the cap. A record more than one window ahead of now is ignored: it was
 * written while the clock ran far ahead, and counting it would block reports
 * until real time caught up.
 */
export async function readRecentFeedbackSends(now: number = Date.now()): Promise<FeedbackSend[]> {
  const path = sendsFile();
  try {
    // No exists() first: a Bun.file handle keeps the size it first saw, so a
    // file another send replaced in between reads cut short.
    const data: unknown = await Bun.file(path).json();
    const sends = (data as { sends?: unknown })?.sends;
    if (!Array.isArray(sends)) return [];
    const valid = sends
      .filter(isFeedbackSend)
      .filter((send) => send.sentAt - now <= FEEDBACK_WINDOW_MS);
    const windowEnd = valid.reduce((latest, send) => Math.max(latest, send.sentAt), now);
    return valid
      .filter((send) => windowEnd - send.sentAt < FEEDBACK_WINDOW_MS)
      .sort((a, b) => a.sentAt - b.sentAt);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      log.debug(`feedback: failed to read ${path}: ${error}`);
    }
    return [];
  }
}

export function checkFeedbackRateLimit(
  recent: FeedbackSend[],
  report: { command: string | null; errorCode: string | null },
): RateLimitVerdict {
  if (recent.length >= FEEDBACK_DAILY_LIMIT) return { allowed: false, reason: "daily_limit" };
  if (
    report.command !== null &&
    report.errorCode !== null &&
    recent.some(
      (send) =>
        !send.dailyTotalOnly &&
        send.command === report.command &&
        send.errorCode === report.errorCode,
    )
  ) {
    return { allowed: false, reason: "repeat" };
  }
  return { allowed: true };
}

/** Append one attempted send, pruning anything outside the window (measured as {@link readRecentFeedbackSends} does). Best effort. */
export async function recordFeedbackSend(send: FeedbackSend): Promise<void> {
  const path = sendsFile();
  const temp = `${path}.${process.pid}-${randomUUID()}.tmp`;
  try {
    const recent = await readRecentFeedbackSends(send.sentAt);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(temp, JSON.stringify({ sends: [...recent, send] }));
    await rename(temp, path);
    log.debug(`feedback: recorded send in ${path}`);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    log.debug(`feedback: failed to write ${path}: ${error}`);
  }
}
