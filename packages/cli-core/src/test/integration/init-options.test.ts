/**
 * init CLI option registration
 * Exercises `clerk init` through the real Commander program to catch
 * options that are advertised in help/examples but never registered.
 */

import { test, expect } from "bun:test";
import { useIntegrationTestScenarios, clerk } from "./lib/scenarios.ts";

useIntegrationTestScenarios();

test("init accepts --app without rejecting it as an unknown option", async () => {
  // --prompt exits before any auth/link/scaffold side effects. If --app is
  // not registered with Commander, parseAsync throws `commander.unknownOption`
  // before --prompt can short-circuit, and `clerk` (strict) throws.
  const { stdout, stderr, exitCode } = await clerk("init", "--app", "app_123", "--prompt");
  expect(exitCode).toBe(0);
  expect(stderr).not.toContain("unknown option");
  expect(stdout).toContain("clerk init -y");
});
