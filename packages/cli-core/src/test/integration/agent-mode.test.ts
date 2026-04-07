/**
 * Agent mode provides actionable instructions
 * AI agents get structured prompts instead of interactive flows.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestScenarios, http, clerk } from "./lib/scenarios.ts";

useIntegrationTestScenarios();

test("init --prompt outputs structured agent prompt without API calls", async () => {
  const { stdout } = await clerk("init", "--prompt");
  expect(stdout).toContain("clerk init -y");
  expect(http.requests.length).toBe(0);
});

test("link outputs structured agent prompt without API calls", async () => {
  const { stdout } = await clerk("--mode", "agent", "link");
  expect(stdout).toContain("linking a Clerk application");
  expect(stdout).toContain("## Steps");
  expect(http.requests.length).toBe(0);
});

test("unlink outputs structured agent prompt without API calls", async () => {
  const { stdout } = await clerk("--mode", "agent", "unlink");
  expect(stdout).toContain("unlinking a Clerk application");
  expect(stdout).toContain("## Steps");
  expect(http.requests.length).toBe(0);
});
