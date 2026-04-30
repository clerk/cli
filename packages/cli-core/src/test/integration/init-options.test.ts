/**
 * init CLI option registration
 * Exercises `clerk init` through the real Commander program to catch
 * options that are advertised in help/examples but never registered.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestHarness, clerk } from "./lib/harness.ts";

useIntegrationTestHarness();

test("init accepts --app without rejecting it as an unknown option", async () => {
  // If --app is not registered with Commander, parseAsync throws
  // `commander.unknownOption` which surfaces as "unknown option" in stderr.
  // Init exits non-zero in this test cwd (no framework detected) — that's
  // expected; we only care that the option pipeline accepted --app.
  const result = await clerk.raw("init", "--app", "app_123");
  expect(result.stderr).not.toContain("unknown option");
});
