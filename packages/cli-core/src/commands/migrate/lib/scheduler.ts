/**
 * Concurrency gate plus rate pacing for BAPI calls.
 *
 * Replaces the standalone migration-tool's `p-limit` dependency: a bounded
 * queue is a few lines, and the compiled binary carries one fewer package.
 *
 * Both limits apply to individual API calls rather than whole users, so a user
 * with ten extra email addresses cannot burst past the instance's rate limit.
 */

/** Runs `fn` once a slot is free and the pacing interval has elapsed. */
export type ApiScheduler = <T>(fn: () => Promise<T>) => Promise<T>;

export function createApiScheduler(concurrencyLimit: number, rateLimit: number): ApiScheduler {
  const maxConcurrent = Math.max(1, Math.floor(concurrencyLimit));
  const intervalMs = Math.ceil(1000 / Math.max(1, rateLimit));
  const waiting: (() => void)[] = [];
  let active = 0;
  let nextRequestAt = 0;

  function acquire(): Promise<void> {
    if (active < maxConcurrent) {
      active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiting.push(resolve));
  }

  function release(): void {
    const next = waiting.shift();
    // Hand the slot straight to the next waiter; `active` is unchanged because
    // the slot never actually frees up.
    if (next) next();
    else active--;
  }

  return async (fn) => {
    await acquire();
    try {
      const now = Date.now();
      const waitMs = Math.max(0, nextRequestAt - now);
      nextRequestAt = Math.max(now, nextRequestAt) + intervalMs;
      if (waitMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
      return await fn();
    } finally {
      release();
    }
  };
}
