import { test, expect, describe } from "bun:test";
import { findCheck } from "./catalog.ts";
import { INSECURE_CONFIG } from "./fixtures.ts";
import { deepMerge, projectPatches } from "./merge.ts";
import type { CheckDef } from "./types.ts";

describe("deepMerge", () => {
  test("merges nested objects and keeps untouched keys", () => {
    expect(deepMerge({ a: { x: 1, y: 2 }, b: 1 }, { a: { y: 3 } })).toEqual({
      a: { x: 1, y: 3 },
      b: 1,
    });
  });

  test("replaces arrays whole", () => {
    expect(deepMerge({ a: [1, 2] }, { a: [3] })).toEqual({ a: [3] });
  });

  test("later values win on conflicts", () => {
    expect(deepMerge({ a: 1 }, { a: 2 })).toEqual({ a: 2 });
  });

  test("does not mutate its inputs", () => {
    const base = { a: { x: 1 } };
    deepMerge(base, { a: { y: 2 } });
    expect(base).toEqual({ a: { x: 1 } });
  });
});

describe("projectPatches", () => {
  const input = { config: INSECURE_CONFIG, environmentType: "production" };

  test("later checks see earlier patches", () => {
    const lockout = findCheck("user-lockout")!;
    const threshold = findCheck("lockout-threshold")!;
    const { payload, projected } = projectPatches(input, [lockout, threshold]);
    expect(payload).toEqual({
      auth_attack_protection: { user_lockout: { enabled: true, max_attempts: 10 } },
    });
    expect(threshold.evaluate({ ...input, config: projected }).met).toBe(true);
    expect(lockout.evaluate({ ...input, config: projected }).met).toBe(true);
  });

  test("a check already satisfied by an earlier patch is skipped", () => {
    const lockout = findCheck("user-lockout")!;
    const threshold = findCheck("lockout-threshold")!;
    const { payload } = projectPatches(input, [threshold, lockout]);
    expect(payload).toEqual({
      auth_attack_protection: { user_lockout: { enabled: true, max_attempts: 10 } },
    });
  });

  test("array-touching checks compound instead of clobbering", () => {
    const first: CheckDef = {
      ...findCheck("email-verification")!,
      id: "first",
      patch: () => ({ auth_email: { verification_strategies: ["email_link"] } }),
    };
    const { payload } = projectPatches(input, [first, findCheck("email-verification")!]);
    expect(payload).toEqual({
      auth_email: { verify_at_sign_up: true, verification_strategies: ["email_link"] },
    });
  });

  test("skips checks without a patch", () => {
    const { payload } = projectPatches(input, [findCheck("mfa")!]);
    expect(payload).toEqual({});
  });
});
