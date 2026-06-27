/**
 * Structured error codes in agent mode
 * Agents receive JSON errors on stderr with machine-readable codes.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, clerk, mockState } from "./lib/harness.ts";

useIntegrationTestHarness();

function parseJsonError(stderr: string): { code: string; message: string; docsUrl?: string } {
  const parsed = JSON.parse(stderr);
  return parsed.error;
}

test("not_linked error includes code in agent mode", async () => {
  const result = await clerk.raw("--mode", "agent", "env", "pull");
  expect(result.exitCode).toBe(1);
  const error = parseJsonError(result.stderr);
  expect(error.code).toBe("not_linked");
  expect(error.message).toContain("No Clerk project linked");
});

test("auth_required error includes code in agent mode", async () => {
  delete process.env.CLERK_PLATFORM_API_KEY;
  mockState.storedToken = null;
  const result = await clerk.raw("--mode", "agent", "env", "pull", "--app", "app_test");
  expect(result.exitCode).toBe(1);
  const error = parseJsonError(result.stderr);
  expect(error.code).toBe("auth_required");
  expect(error.docsUrl).toBeDefined();
});

test("invalid_key_format error includes code in agent mode", async () => {
  process.env.CLERK_PLATFORM_API_KEY = "sk_wrong_prefix";
  const result = await clerk.raw("--mode", "agent", "env", "pull", "--app", "app_test");
  expect(result.exitCode).toBe(1);
  const error = parseJsonError(result.stderr);
  expect(error.code).toBe("invalid_key_format");
  expect(error.message).toContain("Expected a Platform API key");
});

test("usage_error code for invalid mode flag", async () => {
  const result = await clerk.raw("--mode", "agent", "--mode", "banana", "env", "pull");
  expect(result.exitCode).toBe(64);
  const error = parseJsonError(result.stderr);
  expect(error.code).toBe("usage_error");
});

test("human mode still shows plain text errors (no JSON)", async () => {
  const result = await clerk.raw("--mode", "human", "env", "pull");
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain("error:");
  expect(result.stderr).not.toContain('"code"');
});
