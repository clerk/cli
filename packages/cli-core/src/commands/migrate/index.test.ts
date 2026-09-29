import { describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { getMode, setMode } from "../../mode.ts";
import { createProgram } from "../../cli-program.ts";
import { exportPlatformKeys } from "./export/registry.ts";
import { isAssumeYes, setAssumeYes } from "./lib/assume-yes.ts";

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

  test("registers the import subcommand", () => {
    expect(findCommand(["migrate", "import"])).toBeDefined();
  });

  // The direction is never implied: `import` and `export` are siblings, so a
  // default would make one of them the meaning of the bare group name.
  test("leaves migrate with no default subcommand", () => {
    const migrate = findCommand(["migrate"]) as unknown as { _defaultCommandName?: string };
    expect(migrate._defaultCommandName).toBeFalsy();
  });

  test.each([
    "--source",
    "--dry-run",
    "--allow-partial",
    "--new-run",
    "--require-password",
    "--json",
    "--firebase-signer-key",
    "--firebase-salt-separator",
    "--firebase-rounds",
    "--firebase-mem-cost",
    "--yes",
    "--secret-key",
    "--app",
    "--instance",
  ])("migrate import accepts %s", (flag) => {
    const flags = findCommand(["migrate", "import"])?.options.map((option) => option.long);
    expect(flags).toContain(flag);
  });

  test("registers sources with an optional source and --json", () => {
    const sources = findCommand(["migrate", "sources"]);
    expect(sources?.registeredArguments[0]?.required).toBe(false);
    expect(sources?.options.map((option) => option.long)).toEqual(["--json"]);
  });

  test.each([[["transformers"]], [["transformers", "list"]]])("no longer registers %p", (names) => {
    expect(findCommand(["migrate", ...names])).toBeUndefined();
  });

  test.each([
    "--transformer",
    "--transformer-file",
    "--file",
    "--resume-after",
    "--skip-unsupported-providers",
  ])("migrate import drops %s", (flag) => {
    expect(findCommand(["migrate", "import"])?.options.map((o) => o.long)).not.toContain(flag);
  });

  test.each([
    [["export"]],
    [["export", "clerk"]],
    [["export", "auth0"]],
    [["export", "supabase"]],
    [["export", "authjs"]],
    [["export", "betterauth"]],
    [["export", "firebase"]],
  ])("registers migrate %p", (names) => {
    expect(findCommand(["migrate", ...names])).toBeDefined();
  });

  // Bare `migrate export` runs the picker rather than defaulting to a
  // platform, so nobody exports from the wrong place by pressing enter.
  test("leaves export with no default subcommand", () => {
    const group = findCommand(["migrate", "export"]) as unknown as {
      _defaultCommandName?: string;
    };
    expect(group._defaultCommandName).toBeFalsy();
  });

  test("registers an export subcommand per registered platform", () => {
    const registered = findCommand(["migrate", "export"])?.commands.map((c) => c.name());
    for (const key of exportPlatformKeys()) expect(registered).toContain(key);
  });

  test.each(["--output", "--secret-key", "--app", "--instance"])(
    "export clerk accepts %s",
    (flag) => {
      expect(findCommand(["migrate", "export", "clerk"])?.options.map((o) => o.long)).toContain(
        flag,
      );
    },
  );

  test.each(["--domain", "--client-id", "--client-secret", "--output"])(
    "export auth0 accepts %s",
    (flag) => {
      expect(findCommand(["migrate", "export", "auth0"])?.options.map((o) => o.long)).toContain(
        flag,
      );
    },
  );

  test.each(["supabase", "authjs", "betterauth"])("export %s accepts --db-url", (platform) => {
    expect(findCommand(["migrate", "export", platform])?.options.map((o) => o.long)).toContain(
      "--db-url",
    );
  });

  test("export firebase accepts --service-account", () => {
    expect(findCommand(["migrate", "export", "firebase"])?.options.map((o) => o.long)).toContain(
      "--service-account",
    );
  });

  test.each(exportPlatformKeys())(
    "migrate export %s names the run folder as the default output",
    (platform) => {
      const output = findCommand(["migrate", "export", platform])?.options.find(
        (option) => option.long === "--output",
      );
      expect(output?.description).toContain("instead of the run folder");
    },
  );

  test.each(exportPlatformKeys())("migrate export %s accepts --json", (platform) => {
    const flags = findCommand(["migrate", "export", platform])?.options.map((o) => o.long);
    expect(flags).toContain("--json");
  });

  test("registers runs with an optional run ID", () => {
    const runs = findCommand(["migrate", "runs"]);
    expect(runs?.registeredArguments[0]?.required).toBe(false);
    expect(runs?.options.map((option) => option.long)).toEqual(["--json", "--runs-dir"]);
  });

  test("registers undo with a required run ID and its flags", () => {
    const undo = findCommand(["migrate", "undo"]);
    expect(undo?.registeredArguments[0]?.required).toBe(true);
    expect(undo?.options.map((option) => option.long)).toEqual([
      "--dry-run",
      "--yes",
      "--json",
      "--secret-key",
      "--app",
      "--instance",
      "--runs-dir",
    ]);
  });

  test("the logs group is gone: runs replaces it", () => {
    expect(findCommand(["migrate", "logs"])).toBeUndefined();
  });

  // Every command reads or writes the run store, so each one can be pointed
  // somewhere else.
  test.each([
    [["import"]],
    [["runs"]],
    [["undo"]],
    [["export"]],
    ...exportPlatformKeys().map((platform) => [["export", platform]]),
  ])("migrate %p accepts --runs-dir", (names) => {
    expect(findCommand(["migrate", ...names])?.options.map((option) => option.long)).toContain(
      "--runs-dir",
    );
  });

  // It also takes a path, so it cannot use `.choices()`: completion offers the
  // built-in keys through `KNOWN_OPTION_VALUES` instead.
  test("--source accepts any value, so a path to a source you wrote gets through", () => {
    const option = findCommand(["migrate", "import"])?.options.find((o) => o.long === "--source");
    expect(option?.argChoices).toBeUndefined();
  });

  test("takes the file, or the export run that wrote it, as an optional argument", () => {
    const [argument] = findCommand(["migrate", "import"])?.registeredArguments ?? [];
    expect(argument?.name()).toBe("file|export-run-id");
    expect(argument?.required).toBe(false);
  });

  test.each([["-y", "--yes"]])("exposes %s as the short form of %s", (short, long) => {
    const option = findCommand(["migrate", "import"])?.options.find((o) => o.long === long);
    expect(option?.short).toBe(short);
  });

  // Every export takes `-y`: it is what turns the credential-retry loop off,
  // and the loop is on every one of them.
  test.each(exportPlatformKeys())("migrate export %s accepts --yes", (platform) => {
    const flags = findCommand(["migrate", "export", platform])?.options.map((o) => o.long);
    expect(flags).toContain("--yes");
  });
});

/**
 * The hook is the only link between the parsed flag and the two places that
 * read it, three layers down. If it stopped firing — a Commander upgrade that
 * dropped hook inheritance, an action registered outside the group — both
 * behaviours would silently revert and every unit test around them would still
 * pass, because they set the flag directly.
 */
describe("the migrate group's -y hook", () => {
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

  test("records -y on an export", async () => {
    expect(await parse(["migrate", "export", "supabase", "-y", "--db-url", "./none.sqlite"])).toBe(
      true,
    );
  });

  // `--json` means nobody reads a prompt, and agent mode is how every prompt in
  // this tree already knows to stand down.
  test("--json runs the command in agent mode", async () => {
    const original = getMode();
    const runsDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-json-"));
    try {
      setMode("human");
      await parse(["migrate", "runs", "--json", "--runs-dir", runsDir]);
      expect(getMode()).toBe("agent");
    } finally {
      setMode(original);
      fs.rmSync(runsDir, { recursive: true, force: true });
    }
  });

  test("records its absence, so a previous run cannot leak into this one", async () => {
    setAssumeYes(true);
    expect(await parse(["migrate", "export", "supabase", "--db-url", "./none.sqlite"])).toBe(false);
  });
});
