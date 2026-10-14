import { describe, expect, test } from "bun:test";
import { CliError, EXIT_CODE } from "./errors.ts";
import { isExperimentEnabled, requireExperiment } from "./experimental.ts";

describe("isExperimentEnabled", () => {
  test.each([
    { value: undefined, expected: false },
    { value: "", expected: false },
    { value: "migrate", expected: true },
    { value: " Migrate ", expected: true },
    { value: "other,migrate", expected: true },
    { value: "other, MIGRATE ,x", expected: true },
    { value: "migrates", expected: false },
    { value: "other", expected: false },
  ])("CLERK_EXPERIMENTAL=$value → $expected", ({ value, expected }) => {
    expect(isExperimentEnabled("migrate", { CLERK_EXPERIMENTAL: value })).toBe(expected);
  });
});

describe("requireExperiment", () => {
  test("throws a usage-level CliError naming the variable", () => {
    try {
      requireExperiment("migrate", {});
      throw new Error("expected throw");
    } catch (error) {
      expect(error).toBeInstanceOf(CliError);
      expect((error as CliError).code).toBe("experiment_disabled");
      expect((error as CliError).exitCode).toBe(EXIT_CODE.USAGE);
      expect((error as CliError).message).toContain("CLERK_EXPERIMENTAL=migrate");
    }
  });

  test("passes when enabled", () => {
    expect(() => requireExperiment("migrate", { CLERK_EXPERIMENTAL: "migrate" })).not.toThrow();
  });
});
