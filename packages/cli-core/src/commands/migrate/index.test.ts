import { describe, expect, test } from "bun:test";
import { createProgram } from "../../cli-program.ts";
import { exportPlatformKeys } from "./export/registry.ts";
import { transformerKeys } from "./transformers/registry.ts";

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

  test("registers the run subcommand", () => {
    expect(findCommand(["migrate", "run"])).toBeDefined();
  });

  // Bare `clerk migrate` dispatches to `migrate run`, mirroring how bare
  // `clerk deploy` dispatches to `deploy run`.
  test("makes run the default subcommand, so bare `clerk migrate` starts the wizard", () => {
    const run = findCommand(["migrate", "run"]);
    expect(run as unknown as { _defaultCommandName?: unknown }).toBeDefined();
    const migrate = findCommand(["migrate"]) as unknown as { _defaultCommandName?: string };
    expect(migrate._defaultCommandName).toBe("run");
  });

  test("keeps run visible in help, unlike deploy's hidden default", () => {
    expect(findCommand(["migrate", "run"])?.parent?.commands.map((c) => c.name())).toContain("run");
    expect(
      (findCommand(["migrate", "run"]) as unknown as { _hidden?: boolean })._hidden,
    ).toBeFalsy();
  });

  test.each([
    "--transformer",
    "--file",
    "--resume-after",
    "--require-password",
    "--skip-unsupported-providers",
    "--firebase-signer-key",
    "--firebase-salt-separator",
    "--firebase-rounds",
    "--firebase-mem-cost",
    "--yes",
    "--secret-key",
    "--clerk-secret-key",
    "--app",
    "--instance",
  ])("migrate run accepts %s", (flag) => {
    const flags = findCommand(["migrate", "run"])?.options.map((option) => option.long);
    expect(flags).toContain(flag);
  });

  test.each([[["transformers"]], [["transformers", "list"]]])("registers migrate %p", (names) => {
    expect(findCommand(["migrate", ...names])).toBeDefined();
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

  test("documents the default output location in help", () => {
    expect(findCommand(["migrate", "export", "clerk"])?.description()).toContain(
      "./exports/clerk-export.json",
    );
    expect(findCommand(["migrate", "export", "auth0"])?.description()).toContain(
      "./exports/auth0-export.json",
    );
  });

  test("makes list the default transformers subcommand", () => {
    const group = findCommand(["migrate", "transformers"]) as unknown as {
      _defaultCommandName?: string;
    };
    expect(group._defaultCommandName).toBe("list");
  });

  test.each(["--json", "--transformer-file"])("transformers list accepts %s", (flag) => {
    expect(findCommand(["migrate", "transformers", "list"])?.options.map((o) => o.long)).toContain(
      flag,
    );
  });

  test("migrate run accepts --transformer-file", () => {
    expect(findCommand(["migrate", "run"])?.options.map((o) => o.long)).toContain(
      "--transformer-file",
    );
  });

  // Flat rather than under a noun group: it is the one command in this tree
  // that destroys data in Clerk.
  test("registers delete as a direct subcommand of migrate", () => {
    expect(findCommand(["migrate", "delete"])).toBeDefined();
    expect(findCommand(["migrate", "delete"])?.description()).toContain("last migration");
  });

  test.each(["--yes", "--secret-key", "--clerk-secret-key", "--app", "--instance"])(
    "migrate delete accepts %s",
    (flag) => {
      expect(findCommand(["migrate", "delete"])?.options.map((o) => o.long)).toContain(flag);
    },
  );

  test.each([[["logs"]], [["logs", "list"]], [["logs", "clean"]], [["logs", "convert"]]])(
    "registers migrate %p",
    (names) => {
      expect(findCommand(["migrate", ...names])).toBeDefined();
    },
  );

  // Listing is read-only, so it is safe as the default for a bare
  // `clerk migrate logs`.
  test("makes list the default logs subcommand", () => {
    const logs = findCommand(["migrate", "logs"]) as unknown as { _defaultCommandName?: string };
    expect(logs._defaultCommandName).toBe("list");
  });

  test.each([
    [["logs", "list"], "--json"],
    [["logs", "clean"], "--yes"],
    [["logs", "convert"], "--all"],
  ])("%s accepts %s", (names, flag) => {
    expect(findCommand(["migrate", ...names])?.options.map((option) => option.long)).toContain(
      flag,
    );
  });

  test("logs convert takes variadic file positionals", () => {
    const args = findCommand(["migrate", "logs", "convert"])?.registeredArguments;
    expect(args?.[0]?.variadic).toBe(true);
    expect(args?.[0]?.required).toBe(false);
  });

  test("constrains --transformer to the registered transformers, for validation and completion", () => {
    const option = findCommand(["migrate", "run"])?.options.find((o) => o.long === "--transformer");
    // Tracks the registry so adding a platform needs no edit here.
    expect(option?.argChoices).toEqual(transformerKeys());
  });

  test.each([
    ["-t", "--transformer"],
    ["-f", "--file"],
    ["-r", "--resume-after"],
    ["-y", "--yes"],
  ])("exposes %s as the short form of %s", (short, long) => {
    const option = findCommand(["migrate", "run"])?.options.find((o) => o.long === long);
    expect(option?.short).toBe(short);
  });
});
