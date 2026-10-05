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

describe("with CLERK_EXPERIMENTAL unset", () => {
  test("clerk --help leaves migrate out", () => {
    expect(createProgram().helpInformation()).not.toContain("migrate");
  });

  test.each([
    [["migrate"]],
    [["migrate", "--help"]],
    [["migrate", "import", "users.json", "--yes"]],
    [["migrate", "--not-a-flag"]],
    [["help", "migrate"]],
    [["--verbose", "migrate", "import", "x.json"]],
  ])("clerk %p exits 2 with experiment_disabled", async (args) => {
    const result = await clerk.raw("--mode", "agent", ...args);
    expect(result.exitCode).toBe(2);
    expect(result.stderr).toContain('"code":"experiment_disabled"');
    expect(result.stderr).toContain("CLERK_EXPERIMENTAL=migrate");
  });

  test("completion offers no subcommands under migrate", () => {
    const names = generateCompletions(createProgram(), ["migrate", ""]).completions.map(
      (c) => c.name,
    );
    expect(names.filter((name) => !name.startsWith("-"))).toEqual([]);
  });
});

describe("with CLERK_EXPERIMENTAL=migrate", () => {
  test("clerk --help lists migrate", () => {
    process.env.CLERK_EXPERIMENTAL = "migrate";
    expect(createProgram().helpInformation()).toContain("migrate");
  });
});
