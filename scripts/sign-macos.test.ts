import { test, expect, describe, afterEach } from "bun:test";
import { requireEnvOrFlag, getDarwinTargets } from "./sign-macos.ts";

describe("requireEnvOrFlag", () => {
  afterEach(() => {
    delete process.env.__TEST_SIGN_VAR;
  });

  test("returns flag value when provided", () => {
    expect(requireEnvOrFlag("flag-value", "__TEST_SIGN_VAR", "test-flag")).toBe("flag-value");
  });

  test("falls back to env var when flag is undefined", () => {
    process.env.__TEST_SIGN_VAR = "env-value";
    expect(requireEnvOrFlag(undefined, "__TEST_SIGN_VAR", "test-flag")).toBe("env-value");
  });

  test("prefers flag value over env var", () => {
    process.env.__TEST_SIGN_VAR = "env-value";
    expect(requireEnvOrFlag("flag-value", "__TEST_SIGN_VAR", "test-flag")).toBe("flag-value");
  });

  test("throws when neither flag nor env var is provided", () => {
    expect(() => requireEnvOrFlag(undefined, "__TEST_SIGN_VAR", "test-flag")).toThrow(
      "Missing test-flag: pass --test-flag or set __TEST_SIGN_VAR",
    );
  });
});

describe("getDarwinTargets", () => {
  test("returns all darwin targets when no filter is provided", () => {
    const result = getDarwinTargets();
    expect(result.length).toBe(2);
    expect(result.map((t) => t.name)).toEqual(["darwin-arm64", "darwin-x64"]);
  });

  test("filters to darwin-arm64 when specified", () => {
    const result = getDarwinTargets("darwin-arm64");
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("darwin-arm64");
  });

  test("filters to darwin-x64 when specified", () => {
    const result = getDarwinTargets("darwin-x64");
    expect(result.length).toBe(1);
    expect(result[0]!.name).toBe("darwin-x64");
  });

  test("throws for an invalid target", () => {
    expect(() => getDarwinTargets("linux-x64")).toThrow("Unknown darwin target: linux-x64");
  });

  test("throws for a completely unknown target", () => {
    expect(() => getDarwinTargets("freebsd-arm64")).toThrow("Unknown darwin target: freebsd-arm64");
  });
});
