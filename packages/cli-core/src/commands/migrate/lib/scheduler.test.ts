import { expect, test } from "bun:test";
import { createApiScheduler } from "./scheduler.ts";

/** Resolves after `ms`, so a task can be held open while others queue behind it. */
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test("never runs more tasks at once than the concurrency limit", async () => {
  const schedule = createApiScheduler(3, 10_000);
  let active = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 20 }, () =>
      schedule(async () => {
        active++;
        peak = Math.max(peak, active);
        await wait(5);
        active--;
      }),
    ),
  );

  expect(peak).toBe(3);
  expect(active).toBe(0);
});

test("frees a slot when a task throws, instead of deadlocking the queue", async () => {
  const schedule = createApiScheduler(1, 10_000);

  await expect(schedule(() => Promise.reject(new Error("boom")))).rejects.toThrow("boom");

  // If release() had been skipped on the failure path, this would hang.
  expect(await schedule(async () => "ok")).toBe("ok");
});

test("paces calls to the rate limit", async () => {
  // 100 req/s -> 10ms between starts; 5 calls span at least 4 intervals.
  const schedule = createApiScheduler(5, 100);
  const started = performance.now();

  await Promise.all(Array.from({ length: 5 }, () => schedule(async () => {})));

  expect(performance.now() - started).toBeGreaterThanOrEqual(35);
});

test("returns each task's own resolved value", async () => {
  const schedule = createApiScheduler(2, 10_000);
  const results = await Promise.all([1, 2, 3].map((n) => schedule(async () => n * 2)));
  expect(results).toEqual([2, 4, 6]);
});

test("treats zero or negative limits as one", async () => {
  const schedule = createApiScheduler(0, 10_000);
  let active = 0;
  let peak = 0;

  await Promise.all(
    Array.from({ length: 4 }, () =>
      schedule(async () => {
        active++;
        peak = Math.max(peak, active);
        await wait(2);
        active--;
      }),
    ),
  );

  expect(peak).toBe(1);
});
