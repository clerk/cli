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
 * and nothing else. Two agents sending at once can each read the same count,
 * which the cap tolerates. Every attempted POST is recorded, accepted or not:
 * a send that timed out or was answered with an error may still have landed,
 * and a retry loop against a slow endpoint must still meet the cap. A send
 * refused before any POST (opt-out, cap, a config failure) is not recorded.
 */

import { mkdir } from "node:fs/promises";
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
    (v.errorCode === null || typeof v.errorCode === "string")
  );
}

/** Sends inside the window as of `now`, oldest first. Anything unreadable, or dated in the future, is dropped. */
export async function readRecentFeedbackSends(now: number = Date.now()): Promise<FeedbackSend[]> {
  const path = sendsFile();
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return [];
    const data: unknown = await file.json();
    const sends = (data as { sends?: unknown })?.sends;
    if (!Array.isArray(sends)) return [];
    return sends
      .filter(isFeedbackSend)
      .filter((send) => send.sentAt <= now && now - send.sentAt < FEEDBACK_WINDOW_MS)
      .sort((a, b) => a.sentAt - b.sentAt);
  } catch (error) {
    log.debug(`feedback: failed to read ${path}: ${error}`);
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
    recent.some((send) => send.command === report.command && send.errorCode === report.errorCode)
  ) {
    return { allowed: false, reason: "repeat" };
  }
  return { allowed: true };
}

/** Append one attempted send, pruning anything outside the window. Best effort. */
export async function recordFeedbackSend(send: FeedbackSend): Promise<void> {
  const path = sendsFile();
  try {
    const recent = await readRecentFeedbackSends(send.sentAt);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, JSON.stringify({ sends: [...recent, send] }));
    log.debug(`feedback: recorded send in ${path}`);
  } catch (error) {
    log.debug(`feedback: failed to write ${path}: ${error}`);
  }
}
