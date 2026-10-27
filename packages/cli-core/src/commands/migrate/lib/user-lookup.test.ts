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

// External IDs are not unique: a batch can match more users than one page holds.
test("reads every page of a batch that matches more than one page", async () => {
  const urls: URL[] = [];
  const page = (from: number, count: number) =>
    Array.from({ length: count }, (_, index) => ({
      id: `user_${from + index}`,
      external_id: "-dup",
    }));
  globalThis.fetch = (async (input: string | URL | Request) => {
    urls.push(new URL(input.toString()));
    return Response.json(urls.length === 1 ? page(0, LOOKUP_BATCH) : page(LOOKUP_BATCH, 5));
  }) as unknown as typeof fetch;

  const users = await lookupUsers({
    filter: "external_id",
    values: ["-dup"],
    secretKey: "sk_test_x",
    schedule: createApiScheduler(1, 10_000),
  });

  expect(users).toHaveLength(LOOKUP_BATCH + 5);
  expect(urls).toHaveLength(2);
  expect(urls[0]?.searchParams.has("starting_after")).toBe(false);
  expect(urls[1]?.searchParams.get("starting_after")).toBe(`user_${LOOKUP_BATCH - 1}`);
  // The `+` keeps a leading `-` from reading as "exclude".
  expect(urls[0]?.searchParams.getAll("external_id")).toEqual(["+-dup"]);
});

// Stopping quietly would pass a short lookup off as complete.
test("fails, rather than looping or stopping short, when the cursor does not move", async () => {
  let requests = 0;
  // A server that ignores `starting_after` serves the same full page again.
  globalThis.fetch = (async () => {
    requests++;
    return Response.json(
      Array.from({ length: LOOKUP_BATCH }, (_, index) => ({ id: `user_${index}` })),
    );
  }) as unknown as typeof fetch;

  await expect(
    lookupUsers({
      filter: "external_id",
      values: ["a"],
      secretKey: "sk_test_x",
      schedule: createApiScheduler(1, 10_000),
    }),
  ).rejects.toThrow(/same page of users twice/);
  expect(requests).toBe(2);
});
