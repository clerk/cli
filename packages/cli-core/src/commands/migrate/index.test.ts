import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMode, setMode } from "../../mode.ts";
import { createProgram } from "../../cli-program.ts";
import { isAssumeYes, setAssumeYes } from "./lib/assume-yes.ts";

let saved: string | undefined;
beforeAll(() => {
  saved = process.env.CLERK_EXPERIMENTAL;
  process.env.CLERK_EXPERIMENTAL = "migrate";
});
afterAll(() => {
  if (saved === undefined) delete process.env.CLERK_EXPERIMENTAL;
  else process.env.CLERK_EXPERIMENTAL = saved;
});

function findCommand(names: string[]) {
  let current = createProgram().commands.find((cmd) => cmd.name() === names[0]);
  for (const name of names.slice(1)) {
    current = current?.commands.find((cmd) => cmd.name() === name);
  }
  return current;
}

describe("registerMigrate", () => {
  test("registers migrate as a top-level command group", () => {
    const migrate = findCommand(["migrate"]);
    expect(migrate).toBeDefined();
    expect(migrate?.description()).toContain("Migrate users");
  });

  test("registers import as its only subcommand", () => {
    expect(findCommand(["migrate"])?.commands.map((cmd) => cmd.name())).toEqual(["import"]);
  });

  test("leaves migrate with no default subcommand", () => {
    const migrate = findCommand(["migrate"]) as unknown as { _defaultCommandName?: string };
    expect(migrate._defaultCommandName).toBeFalsy();
  });

  test("migrate import takes exactly its flags", () => {
    expect(findCommand(["migrate", "import"])?.options.map((option) => option.long)).toEqual([
      "--source",
      "--dry-run",
      "--allow-partial",
      "--require-password",
      "--skip-legal-checks",
      "--yes",
      "--json",
      "--secret-key",
      "--app",
      "--instance",
      "--runs-dir",
    ]);
  });

  // No `.choices()`: an unknown key reaches resolveSource, whose error lists
  // the valid ones. Completion offers them through `KNOWN_OPTION_VALUES`.
  test("--source accepts any value", () => {
    const option = findCommand(["migrate", "import"])?.options.find((o) => o.long === "--source");
    expect(option?.argChoices).toBeUndefined();
  });

  test("takes the file as an optional argument", () => {
    const [argument] = findCommand(["migrate", "import"])?.registeredArguments ?? [];
    expect(argument?.name()).toBe("file");
    expect(argument?.required).toBe(false);
  });

  test("exposes -y as the short form of --yes", () => {
    const option = findCommand(["migrate", "import"])?.options.find((o) => o.long === "--yes");
    expect(option?.short).toBe("-y");
  });
});

/**
 * The hook is the only link between the parsed flag and the code that reads
 * it below the action. If it stopped firing — a Commander upgrade that dropped
 * hook inheritance, an action registered outside the group — the behaviour
 * would silently revert and every unit test around it would still pass,
 * because they set the flag directly.
 */
describe("the migrate group's -y hook", () => {
  let missing: string;
  beforeAll(() => {
    missing = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-hook-")), "none.json");
  });

  async function parse(argv: string[]) {
    const program = createProgram();
    // `exitOverride` so a usage error inside the action throws here instead of
    // taking the test runner down with it; the hook has already run by then.
    program.exitOverride();
    try {
      await program.parseAsync(["node", "clerk", ...argv]);
    } catch {
      // The action is allowed to fail — only the hook's effect is under test.
    }
    return isAssumeYes();
  }

  test("records -y on import", async () => {
    expect(await parse(["migrate", "import", missing, "-y", "--secret-key", "sk_test_x"])).toBe(
      true,
    );
  });

  // `--json` means nobody reads a prompt, and agent mode is how every prompt in
  // this tree already knows to stand down.
  test("--json runs the command in agent mode", async () => {
    const original = getMode();
    try {
      setMode("human");
      await parse(["migrate", "import", missing, "--json", "--secret-key", "sk_test_x"]);
      expect(getMode()).toBe("agent");
    } finally {
      setMode(original);
    }
  });

  test("records its absence, so a previous run cannot leak into this one", async () => {
    setAssumeYes(true);
    expect(await parse(["migrate", "import", missing, "--secret-key", "sk_test_x"])).toBe(false);
  });
});
