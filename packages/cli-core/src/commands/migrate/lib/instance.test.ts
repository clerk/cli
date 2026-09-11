import { describe, expect, test } from "bun:test";
import {
  DEV_USER_LIMIT,
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
