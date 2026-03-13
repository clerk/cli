/**
 * Agent mode provides actionable instructions
 * AI agents get structured prompts instead of interactive flows.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, http, clerk, mockState } from "../lib/setup.ts";

useIntegrationTestHarness();

test("init outputs structured JSON without API calls", async () => {
  const { stdout } = await clerk("--mode", "agent", "init");
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.command).toBe("init");
  expect(parsed.checks).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "authenticated", ok: true })]),
  );
  expect(http.requests.length).toBe(0);
});

test("link outputs structured JSON for unauthenticated state without API calls", async () => {
  mockState.storedToken = null;
  const { stdout } = await clerk("--mode", "agent", "link");
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.command).toBe("link");
  expect(parsed.checks).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ name: "authenticated", ok: false, fix: "clerk auth login" }),
    ]),
  );
  expect(http.requests.length).toBe(0);
});

test("unlink outputs structured JSON without API calls", async () => {
  const { stdout } = await clerk("--mode", "agent", "unlink");
  const parsed = JSON.parse(stdout.trim());
  expect(parsed.command).toBe("unlink");
  expect(parsed.checks).toEqual(
    expect.arrayContaining([expect.objectContaining({ name: "linked", ok: false })]),
  );
  expect(http.requests.length).toBe(0);
});
