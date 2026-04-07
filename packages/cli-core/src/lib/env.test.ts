import { test, expect, afterEach } from "bun:test";
import { env } from "./env.ts";
import { CliError } from "./errors.ts";

const TEST_VAR = "_CLERK_CLI_ENV_TEST_VAR";

afterEach(() => {
  delete process.env[TEST_VAR];
});

test("env.get returns the value when set", () => {
  process.env[TEST_VAR] = "value";
  expect(env.get(TEST_VAR)).toBe("value");
});

test("env.get returns undefined when missing", () => {
  expect(env.get(TEST_VAR)).toBeUndefined();
});

test("env.require returns the value when set", () => {
  process.env[TEST_VAR] = "value";
  expect(env.require(TEST_VAR)).toBe("value");
});

test("env.require throws CliError when missing", () => {
  expect(() => env.require(TEST_VAR)).toThrow(CliError);
  expect(() => env.require(TEST_VAR)).toThrow(/_CLERK_CLI_ENV_TEST_VAR/);
});
