import { describe, expect, test } from "bun:test";
import {
  DEV_USER_LIMIT,
  resolveUserLimit,
  detectInstanceType,
  getDefaultConcurrencyLimit,
  getDefaultRateLimit,
  getRetryDelay,
  resolveLimits,
} from "./instance.ts";

describe("detectInstanceType", () => {
  test.each([
    ["sk_live_abc123", "prod"],
    ["sk_test_abc123", "dev"],
    ["sk_something_else", "dev"],
    ["nonsense", "dev"],
  ])("%s -> %s", (key, expected) => {
    expect(detectInstanceType(key)).toBe(expected as "dev" | "prod");
  });
});

describe("default limits", () => {
  test.each([
    ["prod", 100],
    ["dev", 10],
  ])("%s instances get %i req/s", (instanceType, expected) => {
    expect(getDefaultRateLimit(instanceType as "dev" | "prod")).toBe(expected);
  });

  test.each([
    [100, 9],
    [10, 1],
    [1, 1],
  ])("a %i req/s limit yields %i concurrent calls", (rateLimit, expected) => {
    expect(getDefaultConcurrencyLimit(rateLimit)).toBe(expected);
  });

  test("development instances default to 100 users", () => {
    expect(DEV_USER_LIMIT).toBe(100);
  });
});

describe("resolveUserLimit", () => {
  // Without `max_allowed_users`, a development instance falls back.
  test.each([
    [undefined, { limit: 100, source: "default" }],
    ["500", { limit: 500, source: "env" }],
    ["250.7", { limit: 250, source: "env" }],
    ["0", { limit: 100, source: "default" }],
    ["-5", { limit: 100, source: "default" }],
    ["lots", { limit: 100, source: "default" }],
  ] as const)("CLERK_MIGRATE_DEV_USER_LIMIT=%p gives %p", (value, expected) => {
    expect(resolveUserLimit(undefined, "dev", { CLERK_MIGRATE_DEV_USER_LIMIT: value })).toEqual(
      expected,
    );
  });

  // Clerk's own number is the one it enforces, so it beats the variable.
  test.each([["dev"], ["prod"]] as const)("a reported limit wins on %s", (type) => {
    expect(resolveUserLimit(500, type, { CLERK_MIGRATE_DEV_USER_LIMIT: "50" })).toEqual({
      limit: 500,
      source: "instance",
    });
  });

  test("a reported null is no limit, even on a development instance", () => {
    expect(resolveUserLimit(null, "dev", { CLERK_MIGRATE_DEV_USER_LIMIT: "50" })).toBeUndefined();
  });

  test("production has no limit when Clerk did not report one", () => {
    expect(resolveUserLimit(undefined, "prod", {})).toBeUndefined();
  });
});

describe("resolveLimits", () => {
  test("derives both limits from the key when nothing is overridden", () => {
    expect(resolveLimits("sk_live_x", {})).toEqual({
      instanceType: "prod",
      rateLimit: 100,
      concurrencyLimit: 9,
    });
  });

  test("honours environment overrides", () => {
    expect(
      resolveLimits("sk_test_x", {
        CLERK_MIGRATE_RATE_LIMIT: "50",
        CLERK_MIGRATE_CONCURRENCY_LIMIT: "4",
      }),
    ).toEqual({ instanceType: "dev", rateLimit: 50, concurrencyLimit: 4 });
  });

  test("derives concurrency from an overridden rate limit", () => {
    expect(resolveLimits("sk_test_x", { CLERK_MIGRATE_RATE_LIMIT: "200" }).concurrencyLimit).toBe(
      19,
    );
  });

  test.each([["0"], ["-5"], ["fast"], [""]])(
    "ignores the unusable override %p in favour of the default",
    (value) => {
      expect(resolveLimits("sk_test_x", { CLERK_MIGRATE_RATE_LIMIT: value }).rateLimit).toBe(10);
    },
  );
});

describe("getRetryDelay", () => {
  test.each([
    [undefined, 10_000, 10_000, 10],
    [15, 10_000, 15_000, 15],
    [1, 10_000, 1000, 1],
  ])("Retry-After %p -> %i ms", (retryAfter, fallback, delayMs, delaySeconds) => {
    expect(getRetryDelay(retryAfter, fallback)).toEqual({ delayMs, delaySeconds });
  });
});
