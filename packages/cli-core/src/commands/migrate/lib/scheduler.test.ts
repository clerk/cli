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

// A 429 means the instance is over its limit for everyone, not just the call
// that hit it.
test("holds every unsent call through a pause", async () => {
  const schedule = createApiScheduler(4, 10_000);
  const started = performance.now();
  schedule.pause(300);

  const startedAt = await Promise.all(
    Array.from({ length: 3 }, async () => schedule(async () => performance.now() - started)),
  );

  for (const at of startedAt) expect(at).toBeGreaterThanOrEqual(290);
});

// Released together, the held calls would hit the limit the pause waited out.
test("keeps calls paced when a pause ends", async () => {
  const schedule = createApiScheduler(4, 10);
  const started = performance.now();
  const first = schedule(async () => schedule.pause(300));
  const held = [1, 2, 3].map(async () => schedule(async () => performance.now() - started));

  await first;
  const startedAt = (await Promise.all(held)).sort((a, b) => a - b);
  // 80 of the 100ms: a loaded runner's timers drift (89.97ms seen in CI),
  // while a doubled rate would space them 50ms apart and a burst about 0.
  for (let i = 1; i < startedAt.length; i++) {
    expect(startedAt[i]! - startedAt[i - 1]!).toBeGreaterThanOrEqual(80);
  }
});

test("holds a call already waiting on the pacing interval", async () => {
  // 2 req/s: the second call waits ~500ms. The first, like a 429, pauses the
  // run while the second is in that wait.
  const schedule = createApiScheduler(2, 2);
  const started = performance.now();
  const first = schedule(async () => schedule.pause(800));
  const second = schedule(async () => performance.now() - started);

  await first;
  expect(await second).toBeGreaterThanOrEqual(790);
});
