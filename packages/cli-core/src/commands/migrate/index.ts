import type { Program } from "../../cli-program.ts";
import { isExperimentEnabled, requireExperiment } from "../../lib/experimental.ts";
import { setMode } from "../../mode.ts";
import { setAssumeYes } from "./lib/assume-yes.ts";
import { RUNS_DIR_DESCRIPTION, RUNS_DIR_FLAG } from "./lib/run-store.ts";
import { run } from "./run.ts";

export function registerMigrate(program: Program, env: NodeJS.ProcessEnv = process.env): void {
  if (!isExperimentEnabled("migrate", env)) {
    // A hidden stub rather than no command at all: `clerk migrate` then says how
    // to turn it on instead of "unknown command". It has no subcommands, so
    // completion has nothing to walk, and it accepts anything, so every
    // invocation reaches the refusal.
    const stub = program
      .command("migrate", { hidden: true })
      .helpOption(false)
      .allowUnknownOption()
      .allowExcessArguments()
      .argument("[args...]")
      .action(() => requireExperiment("migrate", env));
    // `clerk help migrate` renders help without running the action.
    stub.helpInformation = () => {
      requireExperiment("migrate", env);
      return "";
    };
    return;
  }

  const migrateCommand = program
    .command("migrate")
    .description("Migrate users into Clerk from another auth provider or another Clerk instance")
    .setExamples([
      {
        command: "clerk migrate import users.json --source supabase --dry-run",
        description: "Check a Supabase export against the instance, and write nothing",
      },
      {
        command: "clerk migrate import users.json --source supabase --yes",
        description: "Import it",
      },
    ]);

  // `-y` is read below the action, so it is resolved once here rather than
  // threaded through every call. Hooks are inherited, so this fires for every
  // subcommand under `migrate`; one that declares no `-y` resolves to false.
  //
  // `--json` means nobody is reading a prompt, so it runs the command in agent
  // mode: every prompt in this tree already stands down for an agent, with the
  // usage error naming what to pass instead.
  migrateCommand.hook("preAction", (_thisCommand, actionCommand) => {
    const opts = actionCommand.optsWithGlobals();
    setAssumeYes(Boolean(opts.yes));
    if (opts.json) setMode("agent");
  });

  // Named, not `isDefault`: bare `clerk migrate` prints help.
  //
  // The flags stay here rather than on `migrate`, matching how `config` keeps
  // its own on `pull`/`patch`/`put` — a group's help is a list of subcommands
  // and examples, not a merge of everything underneath it.
  migrateCommand
    .command("import")
    .description("Import users from an exported JSON or CSV file")
    .argument("[file]", "A JSON or CSV export")
    .option("--source <key>", "Where the file came from")
    .option("--dry-run", "Check the file against the instance, report, and write nothing")
    .option("--allow-partial", "Import the users that pass the checks, and skip the rest")
    .option("--require-password", "Import only users that have a password")
    .option(
      "--skip-legal-checks",
      "Import users with no legal acceptance on record into an instance that requires it",
    )
    .option("-y, --yes", "Import without prompting")
    .option("--json", "Output as JSON; never prompts, so pair it with --yes to import")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .setExamples([
      {
        command: "clerk migrate import users.json --source supabase --dry-run",
        description: "Check the file against the instance, and write nothing",
      },
      {
        command: "clerk migrate import users.json --source clerk --allow-partial --yes",
        description: "Import a Clerk Dashboard export, skipping users that would be rejected",
      },
    ])
    .action(async (input, _opts, cmd) =>
      run({
        ...(cmd.optsWithGlobals() as Parameters<typeof run>[0]),
        ...(input ? { input } : {}),
      }),
    );
}
