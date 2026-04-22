/**
 * Agent mode provides actionable instructions
 * AI agents execute deterministic flows without interactive prompts.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, http, clerk, readConfig, MOCK_APP } from "./lib/harness.ts";

useIntegrationTestHarness();

test("init --prompt outputs structured agent prompt without API calls", async () => {
  const { stdout } = await clerk("init", "--prompt");
  expect(stdout).toContain("clerk init -y");
  expect(http.requests.length).toBe(0);
});

test("link with --app writes the profile in agent mode", async () => {
  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  await clerk("--mode", "agent", "link", "--app", MOCK_APP.application_id);

  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]?.appId).toBe(MOCK_APP.application_id);
  expect(
    http.requests.some((r) => r.url.includes(`/applications/${MOCK_APP.application_id}`)),
  ).toBe(true);
});

test("unlink requires --yes in agent mode", async () => {
  const result = await clerk.raw("--mode", "agent", "unlink");
  expect(result.exitCode).toBe(2);
  expect(result.stderr).toContain("Pass --yes to unlink in agent mode.");
});

test("unlink --yes removes the profile in agent mode", async () => {
  http.mock({
    [`/applications/${MOCK_APP.application_id}`]: MOCK_APP,
  });

  await clerk("--mode", "agent", "link", "--app", MOCK_APP.application_id);
  await clerk("--mode", "agent", "unlink", "--yes");

  const config = await readConfig();
  expect(config.profiles["github.com/test/project"]).toBeUndefined();
});
