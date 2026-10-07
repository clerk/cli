import type { Program } from "../../cli-program.ts";
import { parseIntegerOption } from "../../lib/option-parsers.ts";
import { setMode } from "../../mode.ts";
import { setAssumeYes } from "./lib/assume-yes.ts";
import { registerMigrateExport } from "./export/index.ts";
import { RUNS_DIR_DESCRIPTION, RUNS_DIR_FLAG } from "./lib/run-store.ts";
import { run } from "./run.ts";
import { runs } from "./runs.ts";
import { undo } from "./undo.ts";
import { list as sources } from "./sources/list.ts";

const migrate = { run, runs, undo, sources };

export function registerMigrate(program: Program): void {
  const migrateCommand = program
    .command("migrate")
    .description("Migrate users into Clerk from another auth provider or another Clerk instance")
    .setExamples([
      {
        command: "clerk migrate export supabase",
        description: "Export users from Supabase into a new run",
      },
      {
        command: "clerk migrate import 20260929-141502-a1b2 --dry-run",
        description: "Check an export against the instance, and write nothing",
      },
      {
        command: "clerk migrate import 20260929-141502-a1b2 --yes",
        description: "Import it",
      },
      { command: "clerk migrate runs", description: "List every migration run" },
      {
        command: "clerk migrate undo 20260929-141502-a1b2",
        description: "Delete the users an import created",
      },
      { command: "clerk migrate sources", description: "What each source brings across" },
    ]);

  // `-y` is read several layers down — by the credential-retry loop and the
  // export commands — so it is resolved once here rather than threaded
  // through every export handler. Hooks are inherited, so this fires for every
  // subcommand under `migrate`; one that declares no `-y` resolves to false.
  //
  // `--json` means nobody is reading a prompt, so it runs the command in agent
  // mode: every prompt in this tree already stands down for an agent, with the
  // usage error naming what to pass instead.
  migrateCommand.hook("preAction", (_thisCommand, actionCommand) => {
    // With globals: `export auth0 --json` lands on the export group's own
    // --json, which the subcommand's opts() never sees.
    const opts = actionCommand.optsWithGlobals();
    setAssumeYes(Boolean(opts.yes));
    if (opts.json) setMode("agent");
  });

  // Named, not `isDefault`. `import` and `export` are the two directions this
  // group moves users in, and neither is implied by the bare group name — a
  // default would make `clerk migrate --file users.json` mean "import" while
  // its sibling has to be spelled out. Bare `clerk migrate` prints help.
  //
  // The flags stay here rather than on `migrate`, matching how `config` keeps
  // its own on `pull`/`patch`/`put` — a group's help is a list of subcommands
  // and examples, not a merge of everything underneath it.
  migrateCommand
    .command("import")
    .description("Import users from an exported JSON or CSV file")
    .argument("[file|export-run-id]", "The export file, or the ID of the export run that wrote it")
    .option(
      "--source <key|path>",
      "Where the file came from: a built-in source, or a source you wrote. Not needed for a file from `clerk migrate export`",
    )
    .option("--dry-run", "Check the file against the instance, report, and write nothing")
    .option("--allow-partial", "Import the users that pass the checks, and skip the rest")
    .option("--new-run", "Start a new run instead of continuing an earlier one of this file")
    .option("--require-password", "Import only users that have a password")
    .option(
      "--skip-legal-checks",
      "Import users with no legal acceptance on record into an instance that requires it",
    )
    .option(
      "--reserve-unverified",
      "Create emails and phones the source never verified as reserved (usable for sign-in, locked to the user) instead of unverified",
    )
    .option("--firebase-signer-key <key>", "Firebase base64 signer key (overrides the export file)")
    .option("--firebase-salt-separator <separator>", "Firebase base64 salt separator")
    .option("--firebase-rounds <n>", "Firebase scrypt rounds", (value: string) =>
      parseIntegerOption(value, "--firebase-rounds", { min: 1 }),
    )
    .option("--firebase-mem-cost <n>", "Firebase scrypt memory cost", (value: string) =>
      parseIntegerOption(value, "--firebase-mem-cost", { min: 1 }),
    )
    .option("-y, --yes", "Import without prompting")
    .option("--json", "Output as JSON; never prompts, so pair it with --yes to import")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .setExamples([
      {
        command: "clerk migrate import 20260929-141502-a1b2 --dry-run",
        description: "Check what an export run wrote, and write nothing",
      },
      {
        command: "clerk migrate import 20260929-141502-a1b2 --yes",
        description: "Import it. Run it again to continue after a failure",
      },
      {
        command: "clerk migrate import users.json --source clerk --allow-partial --yes",
        description: "Import a Clerk Dashboard export, skipping users that would be rejected",
      },
      {
        command: "clerk migrate import users.json --source ./my-source.ts --yes",
        description: "Import with a source you wrote",
      },
    ])
    .action(async (input, _opts, cmd) =>
      migrate.run({
        ...(cmd.optsWithGlobals() as Parameters<typeof migrate.run>[0]),
        ...(input ? { input } : {}),
      }),
    );

  registerMigrateExport(migrateCommand);

  // Flat, not under a noun group: this is the one command in the tree that
  // destroys data in Clerk, and it is worth keeping short and prominent.
  migrateCommand
    .command("undo")
    .description("Delete the users an import run created")
    .argument("<run-id>", "The import run to undo (see `clerk migrate runs`)")
    .option("--dry-run", "Show what would be deleted, and delete nothing")
    .option("-y, --yes", "Delete without prompting")
    .option("--json", "Output as JSON; never prompts, so pair it with --yes to delete")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .setExamples([
      {
        command: "clerk migrate undo 20260929-141502-a1b2 --dry-run",
        description: "Preview what would be deleted",
      },
      {
        command: "clerk migrate undo 20260929-141502-a1b2 --yes",
        description: "Delete without prompting",
      },
    ])
    .action(async (runId, _opts, cmd) =>
      migrate.undo(runId, cmd.optsWithGlobals() as Parameters<typeof migrate.undo>[1]),
    );

  migrateCommand
    .command("runs")
    .description("List migration runs, or show one")
    .argument("[run-id]", "A run to show in full")
    .option("--json", "Output as JSON")
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .setExamples([
      { command: "clerk migrate runs", description: "List every run, newest first" },
      {
        command: "clerk migrate runs 20260929-141502-a1b2",
        description: "Show one run: counts, errors and the users that did not make it",
      },
      { command: "clerk migrate runs --json", description: "Machine-readable listing" },
    ])
    .action(async (runId, _opts, cmd) =>
      migrate.runs(runId, cmd.optsWithGlobals() as Parameters<typeof migrate.runs>[1]),
    );

  // A compiled binary has no source tree to grep, so the available mappings
  // need a command rather than only appearing in the interactive picker.
  migrateCommand
    .command("sources")
    .description("List the sources an import can read, or show one in full")
    .argument("[source]", "A built-in source, or the path to a source you wrote")
    .option("--json", "Output as JSON")
    .setExamples([
      { command: "clerk migrate sources", description: "What each source brings across" },
      {
        command: "clerk migrate sources betterauth",
        description: "Where each field lands, how to export, and caveats",
      },
      { command: "clerk migrate sources ./my-source.ts", description: "Check a source you wrote" },
    ])
    .action(async (source, _opts, cmd) =>
      migrate.sources(source, cmd.optsWithGlobals() as Parameters<typeof migrate.sources>[1]),
    );
}
