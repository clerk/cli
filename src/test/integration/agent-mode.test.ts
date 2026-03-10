/**
 * Agent mode provides actionable instructions
 * AI agents get structured prompts instead of interactive flows.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, requests, clerk } from "./setup.ts";

useIntegrationTestHarness();

test("agent mode outputs prompts without API calls", async () => {
  // init outputs structured agent prompt with steps
  const { stdout: initOutput } = await clerk("--mode", "agent", "init");
  expect(initOutput).toContain("integrating Clerk authentication");
  expect(initOutput).toContain("clerk auth login");
  const initRequestCount = requests.length;

  // link outputs structured agent prompt with API details
  const { stdout: linkOutput } = await clerk("--mode", "agent", "link");
  expect(linkOutput).toContain("linking a Clerk application");
  expect(linkOutput).toContain("## Steps");

  // unlink outputs structured agent prompt with CLI usage
  const { stdout: unlinkOutput } = await clerk("--mode", "agent", "unlink");
  expect(unlinkOutput).toContain("unlinking a Clerk application");
  expect(unlinkOutput).toContain("## Steps");

  // No API calls made by agent-mode commands
  expect(requests.length).toBe(initRequestCount);
});
