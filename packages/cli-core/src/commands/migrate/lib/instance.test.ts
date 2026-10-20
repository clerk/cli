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
  // `max_allowed_users` from GET /v1/instance: a number, null, or absent on an
  // API older than clerk/clerk_go#22871.
  test.each([
    ["dev", 500, { limit: 500, source: "api" }],
    ["prod", 25_000, { limit: 25_000, source: "api" }],
    ["dev", 0, { limit: 0, source: "api" }],
    ["dev", null, { limit: null, source: "api" }],
    ["prod", null, { limit: null, source: "api" }],
    ["dev", undefined, { limit: 100, source: "default" }],
    ["prod", undefined, { limit: null, source: "default" }],
  ] as const)("a %s instance serving %p", (instanceType, served, expected) => {
    expect(resolveUserLimit(instanceType, served, {})).toEqual(expected);
  });

  test.each([
    [undefined, { limit: 100, source: "default" }],
    ["500", { limit: 500, source: "env" }],
    ["250.7", { limit: 250, source: "env" }],
    ["0", { limit: 100, source: "default" }],
    ["-5", { limit: 100, source: "default" }],
    ["lots", { limit: 100, source: "default" }],
  ] as const)(
    "CLERK_MIGRATE_DEV_USER_LIMIT=%p on a dev instance serving none",
    (value, expected) => {
      expect(resolveUserLimit("dev", undefined, { CLERK_MIGRATE_DEV_USER_LIMIT: value })).toEqual(
        expected,
      );
    },
  );

  // The served limit is the one Clerk enforces; the override only stands in
  // for it.
  test.each([[250], [null]])("a served %p wins over CLERK_MIGRATE_DEV_USER_LIMIT", (served) => {
    expect(resolveUserLimit("dev", served, { CLERK_MIGRATE_DEV_USER_LIMIT: "500" })).toEqual({
      limit: served,
      source: "api",
    });
  });

  test("CLERK_MIGRATE_DEV_USER_LIMIT does not limit a production instance", () => {
    expect(
      resolveUserLimit("prod", undefined, { CLERK_MIGRATE_DEV_USER_LIMIT: "500" }).limit,
    ).toBeNull();
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
