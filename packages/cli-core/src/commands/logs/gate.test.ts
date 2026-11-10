import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useIntegrationTestHarness, clerk } from "../../test/integration/lib/harness.ts";
import { generateCompletions } from "../completion/__complete.ts";
import { createProgram } from "../../cli-program.ts";

useIntegrationTestHarness();

let saved: string | undefined;
beforeEach(() => {
  saved = process.env.CLERK_EXPERIMENTAL;
  delete process.env.CLERK_EXPERIMENTAL;
});
afterEach(() => {
  if (saved === undefined) delete process.env.CLERK_EXPERIMENTAL;
  else process.env.CLERK_EXPERIMENTAL = saved;
});

function rootCompletions(): string[] {
  return generateCompletions(createProgram(), [""]).completions.map((c) => c.name);
}

describe("with CLERK_EXPERIMENTAL unset", () => {
  test("clerk --help leaves logs out", () => {
    expect(createProgram().helpInformation()).not.toMatch(/^\s+logs\b/m);
  });

  test("completion leaves logs out of the root commands", () => {
    expect(rootCompletions()).not.toContain("logs");
  });

  test.each([
    [["logs"]],
    [["logs", "list"]],
    [["logs", "--help"]],
    [["logs", "list", "--help"]],
    [["logs", "list", "--json", "--limit", "10"]],
    [["logs", "--not-a-flag"]],
    [["help", "logs"]],
    [["--verbose", "logs", "list"]],
  ])("clerk %p exits 2 with experiment_disabled", async (args) => {
    const result = await clerk.raw("--mode", "agent", ...args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('"code":"experiment_disabled"');
    expect(result.stderr).toContain("CLERK_EXPERIMENTAL=logs");
  });

  test("completion offers no subcommands under logs", () => {
    const names = generateCompletions(createProgram(), ["logs", ""]).completions.map((c) => c.name);
    expect(names.filter((name) => !name.startsWith("-"))).toEqual([]);
  });
});

describe("with CLERK_EXPERIMENTAL=logs", () => {
  test("clerk --help lists logs", () => {
    process.env.CLERK_EXPERIMENTAL = "logs";
    expect(createProgram().helpInformation()).toMatch(/^\s+logs\b/m);
  });

  test("the real list subcommand is registered", () => {
    process.env.CLERK_EXPERIMENTAL = "logs";
    const logs = createProgram().commands.find((c) => c.name() === "logs");
    expect(logs?.commands.map((c) => c.name())).toEqual(["list"]);
  });

  test("completion offers list under logs", () => {
    process.env.CLERK_EXPERIMENTAL = "logs";
    const names = generateCompletions(createProgram(), ["logs", ""]).completions.map((c) => c.name);
    expect(names).toContain("list");
  });
});
