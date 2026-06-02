import { test, expect, describe } from "bun:test";
import { collectOptionValues, parseIntegerOption } from "./option-parsers.ts";

describe("collectOptionValues", () => {
  test("returns the first value in an array when no previous array is supplied", () => {
    expect(collectOptionValues("foo")).toEqual(["foo"]);
  });

  test("appends a new value to the existing array", () => {
    expect(collectOptionValues("bar", ["foo"])).toEqual(["foo", "bar"]);
  });

  test("accumulates multiple values through successive calls", () => {
    const first = collectOptionValues("a");
    const second = collectOptionValues("b", first);
    const third = collectOptionValues("c", second);
    expect(third).toEqual(["a", "b", "c"]);
  });

  test("does not mutate the previous array", () => {
    const prev = ["x"];
    collectOptionValues("y", prev);
    expect(prev).toEqual(["x"]);
  });
});

describe("parseIntegerOption", () => {
  describe("valid inputs", () => {
    test.each([
      { value: "0", min: 0, expected: 0 },
      { value: "1", min: 0, expected: 1 },
      { value: "100", min: 0, max: 200, expected: 100 },
      { value: "-5", min: -10, max: 0, expected: -5 },
      { value: "10", min: 10, max: 10, expected: 10 },
    ])(
      "parses '$value' within range [$min, $max] as $expected",
      ({ value, min, max, expected }) => {
        expect(parseIntegerOption(value, "--flag", { min, max })).toBe(expected);
      },
    );
  });

  describe("non-integer inputs throw a usage error", () => {
    test.each(["1.5", "abc", "", " ", "1e2", "0x1"])("throws for non-integer value %j", (value) => {
      expect(() => parseIntegerOption(value, "--limit", { min: 0 })).toThrow(
        /Invalid --limit value/,
      );
    });
  });

  describe("out-of-range inputs throw a usage error", () => {
    test("throws when value is below min", () => {
      expect(() => parseIntegerOption("-1", "--count", { min: 0 })).toThrow(
        /Invalid --count value "-1". Must be >= 0/,
      );
    });

    test("throws when value is above max", () => {
      expect(() => parseIntegerOption("101", "--count", { min: 0, max: 100 })).toThrow(
        /Invalid --count value "101". Must be 0-100/,
      );
    });

    test("error message uses open-ended format when no max is provided", () => {
      expect(() => parseIntegerOption("0", "--page", { min: 1 })).toThrow(/Must be >= 1/);
    });

    test("error message uses closed-range format when max is provided", () => {
      expect(() => parseIntegerOption("0", "--page", { min: 1, max: 50 })).toThrow(/Must be 1-50/);
    });
  });
});
