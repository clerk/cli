/**
 * Concurrency gate plus rate pacing for BAPI calls.
 *
 * Replaces the standalone migration-tool's `p-limit` dependency: a bounded
 * queue is a few lines, and the compiled binary carries one fewer package.
 *
 * Both limits apply to individual API calls rather than whole users, so a user
 * with ten extra email addresses cannot burst past the instance's rate limit.
 */

import { setTimeout as delay } from "node:timers/promises";

/**
 * Runs `fn` once a slot is free and the pacing interval has elapsed.
 *
 * `first` puts `fn` ahead of every queued call without it: a user's extra
 * identifiers attach before the next user is created, so a run stopped midway
 * leaves few users waiting on attaches.
 */
export type ScheduleOptions = {
  first?: boolean;
  /**
   * Once aborted, `fn` runs at once and takes no paced turn, and a wait
   * already under way is cut short. For a call that will only find the run
   * stopped, so a Ctrl-C or a full instance drains the queue instead of
   * pacing it.
   */
  stop?: AbortSignal;
};

export type ApiScheduler = (<T>(fn: () => Promise<T>, options?: ScheduleOptions) => Promise<T>) & {
  /**
   * Holds every call not yet sent until `ms` from now, so a 429 pauses the
   * whole run rather than only the call that hit it.
   */
  pause(ms: number): void;
};

export function createApiScheduler(concurrencyLimit: number, rateLimit: number): ApiScheduler {
  const maxConcurrent = Math.max(1, Math.floor(concurrencyLimit));
  const intervalMs = Math.ceil(1000 / Math.max(1, rateLimit));
  const waiting: (() => void)[] = [];
  const waitingFirst: (() => void)[] = [];
  let active = 0;
  let nextRequestAt = 0;
  let pausedUntil = 0;

  async function acquire(first: boolean): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => (first ? waitingFirst : waiting).push(resolve));
  }

  function release(): void {
    // One macrotask later, so the finished call's follow-up (a user's attaches)
    // is queued before the slot is handed on.
    setImmediate(() => {
      const next = waitingFirst.shift() ?? waiting.shift();
      // Hand the slot straight to the next waiter; `active` is unchanged
      // because the slot never actually frees up.
      if (next) next();
      else active--;
    });
  }

  const schedule = async <T>(fn: () => Promise<T>, options?: ScheduleOptions) => {
    await acquire(options?.first ?? false);
    try {
      const stop = options?.stop;
      // A pause that starts during the wait takes a fresh paced slot after it,
      // so calls held through a pause resume an interval apart, not together.
      while (!stop?.aborted) {
        const pauseSeen = pausedUntil;
        const now = Date.now();
        const startAt = Math.max(now, nextRequestAt, pausedUntil);
        nextRequestAt = startAt + intervalMs;
        // Rejects only when `stop` aborts, which ends the wait.
        if (startAt > now) await delay(startAt - now, undefined, { signal: stop }).catch(() => {});
        if (pausedUntil === pauseSeen) break;
      }
      return await fn();
    } finally {
      release();
    }
  };

  return Object.assign(schedule, {
    pause(ms: number) {
      pausedUntil = Math.max(pausedUntil, Date.now() + ms);
    },
  });
}
