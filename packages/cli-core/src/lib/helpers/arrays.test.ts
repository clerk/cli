import { test, expect, describe } from "bun:test";
import { isNonEmpty, type NonEmptyArray } from "./arrays.ts";

describe("isNonEmpty", () => {
  test("returns false for an empty array", () => {
    expect(isNonEmpty([])).toBe(false);
  });

  test("returns true for an array with one element", () => {
    expect(isNonEmpty([1])).toBe(true);
  });

  test("returns true for an array with multiple elements", () => {
    expect(isNonEmpty(["a", "b", "c"])).toBe(true);
  });

  test("works with readonly arrays", () => {
    const ro: readonly number[] = [1, 2, 3];
    expect(isNonEmpty(ro)).toBe(true);
  });

  test("narrows the type so [0] is non-undefined", () => {
    const arr: number[] = [42];
    if (isNonEmpty(arr)) {
      // This line is the test — if isNonEmpty didn't narrow, the assignment
      // would be `number | undefined` and TS would error under strict mode.
      const first: number = arr[0];
      expect(first).toBe(42);
    } else {
      throw new Error("expected isNonEmpty to return true");
    }
  });

  test("NonEmptyArray accepts a tuple literal", () => {
    // Compile-time check: this would error if NonEmptyArray rejected a
    // single-element tuple.
    const one: NonEmptyArray<string> = ["hi"];
    expect(one).toHaveLength(1);
  });
});
