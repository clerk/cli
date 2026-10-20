/**
 * `clerk mcp run` was removed in 4.0 but stays registered, hidden, so editors
 * still launching a 3.x bridge entry get an actionable error.
 */

import { describe, expect, test } from "bun:test";
import { clerk, useIntegrationTestHarness } from "./lib/harness.ts";
import { generateCompletions } from "../../commands/completion/__complete.ts";
import { createProgram } from "../../cli-program.ts";

useIntegrationTestHarness();

describe("clerk mcp run (removed)", () => {
  test.each([
    ["no arguments", []],
    ["a hand-edited --url", ["--url", "https://mcp.clerk.com/mcp"]],
    ["extra arguments", ["--name", "clerk", "extra"]],
  ])("reaches the removal error with %s", async (_label, args) => {
    const result = await clerk.raw("--mode", "agent", "mcp", "run", ...args);
    expect(result.exitCode).toBe(1);
    const parsed = JSON.parse(result.stderr) as { error: { code: string } };
    expect(parsed.error.code).toBe("mcp_bridge_removed");
  });

  test("is hidden from completion", () => {
    const names = generateCompletions(createProgram(), ["mcp", ""]).completions.map((c) => c.name);
    expect(names).toContain("install");
    expect(names).not.toContain("run");
  });

  test("is hidden from `clerk mcp --help`", () => {
    const mcp = createProgram().commands.find((command) => command.name() === "mcp");
    const help = mcp?.helpInformation() ?? "";
    expect(help).toContain("install");
    expect(help).not.toMatch(/^\s+run\b/m);
  });
});
