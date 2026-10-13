import { afterEach, beforeEach, expect, test } from "bun:test";
import { createApiScheduler } from "./scheduler.ts";
import { LOOKUP_BATCH, lookupUsers } from "./user-lookup.ts";

let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  originalFetch = globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

// The instance is over its limit for every lookup, not just the one that hit it.
test("holds every other lookup through a 429's wait", async () => {
  const started = performance.now();
  const sentAt: number[] = [];
  globalThis.fetch = (async () => {
    sentAt.push(performance.now() - started);
    return sentAt.length === 1
      ? new Response(JSON.stringify({ errors: [{ code: "x", message: "slow down" }] }), {
          status: 429,
          headers: { "retry-after": "1" },
        })
      : Response.json([]);
  }) as unknown as typeof fetch;

  await lookupUsers({
    filter: "external_id",
    // Two batches, so a second lookup is waiting when the first hits the limit.
    values: Array.from({ length: LOOKUP_BATCH + 1 }, (_, index) => `u${index}`),
    secretKey: "sk_test_x",
    schedule: createApiScheduler(1, 10_000),
  });

  expect(sentAt).toHaveLength(3);
  for (const at of sentAt.slice(1)) expect(at).toBeGreaterThanOrEqual(900);
});

// Lookups run at once share one count, so the spinner only climbs.
test("lookups sharing a count report one total that only climbs", async () => {
  globalThis.fetch = (async () => Response.json([])) as unknown as typeof fetch;
  const updates: string[] = [];
  const progress = { done: 0, total: 0 };
  const lookup = async (filter: "external_id" | "email_address", count: number) =>
    lookupUsers({
      filter,
      values: Array.from({ length: count }, (_, index) => `u${index}`),
      secretKey: "sk_test_x",
      schedule: createApiScheduler(4, 10_000),
      spinner: { update: (message) => updates.push(message) },
      label: "Checking",
      progress,
    });

  await Promise.all([lookup("external_id", LOOKUP_BATCH + 1), lookup("email_address", 1)]);

  expect(updates).toEqual(["Checking: 1/3", "Checking: 2/3", "Checking: 3/3"]);
});
