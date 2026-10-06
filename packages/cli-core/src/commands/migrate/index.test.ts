import { beforeAll, describe, expect, test } from "bun:test";
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

  test("registers import, export, undo, runs and sources", () => {
    expect(findCommand(["migrate"])?.commands.map((cmd) => cmd.name())).toEqual([
      "import",
      "export",
      "undo",
      "runs",
      "sources",
    ]);
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
      "--new-run",
      "--require-password",
      "--skip-legal-checks",
      "--firebase-signer-key",
      "--firebase-salt-separator",
      "--firebase-rounds",
      "--firebase-mem-cost",
      "--yes",
      "--json",
      "--secret-key",
      "--app",
      "--instance",
      "--runs-dir",
    ]);
  });

  test("registers an export subcommand per registered platform", () => {
    // Help order is not registry order, so compare as sets.
    expect(
      findCommand(["migrate", "export"])
        ?.commands.map((cmd) => cmd.name())
        .sort(),
    ).toEqual(exportPlatformKeys().sort());
  });

  // Bare `migrate export` runs the picker rather than defaulting to a
  // platform, so nobody exports from the wrong place by pressing enter.
  test("leaves export with no default subcommand", () => {
    const group = findCommand(["migrate", "export"]) as unknown as {
      _defaultCommandName?: string;
    };
    expect(group._defaultCommandName).toBeFalsy();
  });

  test("migrate export takes exactly its flags", () => {
    expect(findCommand(["migrate", "export"])?.options.map((option) => option.long)).toEqual([
      "--runs-dir",
      "--json",
    ]);
  });

  test("migrate export clerk takes exactly its flags", () => {
    expect(
      findCommand(["migrate", "export", "clerk"])?.options.map((option) => option.long),
    ).toEqual(["--output", "--yes", "--runs-dir", "--json", "--secret-key", "--app", "--instance"]);
  });

  test("migrate export auth0 takes exactly its flags", () => {
    expect(
      findCommand(["migrate", "export", "auth0"])?.options.map((option) => option.long),
    ).toEqual([
      "--domain",
      "--client-id",
      "--client-secret",
      "--output",
      "--yes",
      "--runs-dir",
      "--json",
    ]);
  });

  test.each(["supabase", "authjs", "betterauth"])(
    "migrate export %s takes exactly its flags",
    (platform) => {
      expect(
        findCommand(["migrate", "export", platform])?.options.map((option) => option.long),
      ).toEqual(["--db-url", "--output", "--yes", "--runs-dir", "--json"]);
    },
  );

  test("migrate export firebase takes exactly its flags", () => {
    expect(
      findCommand(["migrate", "export", "firebase"])?.options.map((option) => option.long),
    ).toEqual(["--service-account", "--output", "--yes", "--runs-dir", "--json"]);
  });

  test("migrate export workos takes exactly its flags", () => {
    expect(
      findCommand(["migrate", "export", "workos"])?.options.map((option) => option.long),
    ).toEqual([
      "--api-key",
      "--with-identities",
      "--no-with-identities",
      "--output",
      "--yes",
      "--runs-dir",
      "--json",
    ]);
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

  test("registers runs with an optional run ID", () => {
    const runsCommand = findCommand(["migrate", "runs"]);
    expect(runsCommand?.registeredArguments[0]?.required).toBe(false);
    expect(runsCommand?.options.map((option) => option.long)).toEqual(["--json", "--runs-dir"]);
  });

  test("registers sources with an optional source and --json", () => {
    const sourcesCommand = findCommand(["migrate", "sources"]);
    expect(sourcesCommand?.registeredArguments[0]?.required).toBe(false);
    expect(sourcesCommand?.options.map((option) => option.long)).toEqual(["--json"]);
  });

  test("registers undo with a required run ID and its flags", () => {
    const undoCommand = findCommand(["migrate", "undo"]);
    expect(undoCommand?.registeredArguments[0]?.required).toBe(true);
    expect(undoCommand?.options.map((option) => option.long)).toEqual([
      "--dry-run",
      "--yes",
      "--json",
      "--secret-key",
      "--app",
      "--instance",
      "--runs-dir",
    ]);
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
  let missingDb: string;
  beforeAll(() => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-hook-"));
    missing = path.join(dir, "none.json");
    missingDb = path.join(dir, "none.sqlite");
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

  test("records -y on an export", async () => {
    expect(await parse(["migrate", "export", "supabase", "-y", "--db-url", missingDb])).toBe(true);
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

  // The export group declares --json too, and takes the flag; the hook has to
  // read the group's options as well as the subcommand's.
  test("--json on an export subcommand runs it in agent mode", async () => {
    const original = getMode();
    try {
      setMode("human");
      await parse(["migrate", "export", "supabase", "--json", "--db-url", missingDb]);
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
