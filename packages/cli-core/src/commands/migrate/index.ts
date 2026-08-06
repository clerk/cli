import { createOption } from "@commander-js/extra-typings";
import type { Program } from "../../cli-program.ts";
import { parseIntegerOption } from "../../lib/option-parsers.ts";
import { deleteMigration } from "./delete.ts";
import { registerMigrateExport } from "./export/index.ts";
import { registerMigrateLogs } from "./logs/index.ts";
import { registerMigrateSettings } from "./settings/index.ts";
import { run } from "./run.ts";
import { list as transformersList } from "./transformers/list.ts";
import { transformerKeys } from "./transformers/registry.ts";

const migrate = { run, delete: deleteMigration, transformersList };

export function registerMigrate(program: Program): void {
  const migrateCommand = program
    .command("migrate")
    .description("Migrate users into Clerk from another auth provider")
    .setExamples([
      { command: "clerk migrate", description: "Walk through a migration interactively" },
      {
        command: "clerk migrate -y --transformer clerk --file users.json",
        description: "Import users from a Clerk export",
      },
      {
        command: "clerk migrate -y -t supabase -f users.json --skip-unsupported-providers",
        description: "Skip Supabase users whose provider is not enabled",
      },
      {
        command: "clerk migrate export supabase",
        description: "Export users from Supabase, ready to import",
      },
      { command: "clerk migrate settings", description: "Show what a run here would pick up" },
      {
        command: "clerk migrate settings set firebase-signer-key abc123",
        description: "Save a credential to .env.clerk-migrate",
      },
      { command: "clerk migrate logs", description: "List the local migration logs" },
      { command: "clerk migrate transformers list", description: "Show the built-in transformers" },
      { command: "clerk migrate delete", description: "Undo the last migration" },
    ]);

  // `isDefault` so `clerk migrate` is the whole command: bare, it runs the
  // wizard; with flags, they fall through to here. `run` stays addressable
  // because scripts and older docs use it, but `clerk migrate` is the spelling
  // every example gives.
  //
  // The flags stay here rather than on `migrate`, matching how `config` keeps
  // its own on `pull`/`patch`/`put` — a group's help is a list of subcommands
  // and examples, not a merge of everything underneath it.
  migrateCommand
    .command("run", { isDefault: true })
    .description("Import users from an exported JSON or CSV file")
    .addOption(
      createOption(
        "-t, --transformer <transformer>",
        "Source platform the file was exported from",
      ).choices(transformerKeys()),
    )
    .option(
      "--transformer-file <path>",
      "Path to a transformer you wrote, for a platform with no built-in",
    )
    .option("-f, --file <path>", "Path to the exported user data (JSON or CSV)")
    .option("-r, --resume-after <user-id>", "Skip every user up to and including this source ID")
    .option("--require-password", "Import only users that have a password")
    .option(
      "--skip-unsupported-providers",
      "Supabase: skip users whose only social provider is not enabled in Clerk",
    )
    .option("--firebase-signer-key <key>", "Firebase base64 signer key")
    .option("--firebase-salt-separator <separator>", "Firebase base64 salt separator")
    .option("--firebase-rounds <n>", "Firebase scrypt rounds", (value: string) =>
      parseIntegerOption(value, "--firebase-rounds", { min: 1 }),
    )
    .option("--firebase-mem-cost <n>", "Firebase scrypt memory cost", (value: string) =>
      parseIntegerOption(value, "--firebase-mem-cost", { min: 1 }),
    )
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--clerk-secret-key <key>", "Deprecated alias for --secret-key")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .setExamples([
      {
        command: "clerk migrate -y --transformer clerk --file users.json",
        description: "Import a Clerk Dashboard export",
      },
      {
        command: "clerk migrate -y -t clerk -f users.csv --require-password",
        description: "Import only the users that carry a password digest",
      },
      {
        command: "clerk migrate -y -t clerk -f users.json -r user_2x9k",
        description: "Resume a partial migration after the last imported user",
      },
      {
        command: "clerk migrate -y -t supabase -f users.json --skip-unsupported-providers",
        description: "Skip Supabase users whose only provider is not enabled in Clerk",
      },
    ])
    .action((_opts, cmd) =>
      migrate.run(cmd.optsWithGlobals() as Parameters<typeof migrate.run>[0]),
    );

  // Flat, not under a noun group: this is the one command in the tree that
  // destroys data in Clerk, and it is worth keeping short and prominent.
  migrateCommand
    .command("delete")
    .description("Delete the users created by the last migration for this project")
    .option("-y, --yes", "Skip the confirmation prompt")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--clerk-secret-key <key>", "Deprecated alias for --secret-key")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .setExamples([
      {
        command: "clerk migrate delete",
        description: "Undo the last migration after confirming",
      },
      { command: "clerk migrate delete -y", description: "Undo without prompting" },
    ])
    .action((_opts, cmd) =>
      migrate.delete(cmd.optsWithGlobals() as Parameters<typeof migrate.delete>[0]),
    );

  registerMigrateExport(migrateCommand);

  // A compiled binary has no source tree to grep, so the available mappings
  // need a command rather than only appearing in the interactive picker.
  const transformersCommand = migrateCommand
    .command("transformers")
    .description("Inspect the available source-platform transformers")
    .setExamples([
      { command: "clerk migrate transformers list", description: "Show the built-in transformers" },
      {
        command: "clerk migrate transformers list --json",
        description: "Machine-readable, including each one's ID field",
      },
      {
        command: "clerk migrate transformers list --transformer-file ./my-transformer.ts",
        description: "Include one you wrote",
      },
    ]);

  transformersCommand
    .command("list", { isDefault: true })
    .description("List the built-in transformers, and any loaded from a file")
    .option("--json", "Output as JSON")
    .option("--transformer-file <path>", "Also list a transformer you wrote")
    .setExamples([
      { command: "clerk migrate transformers list", description: "Show the built-in transformers" },
      {
        command: "clerk migrate transformers list --transformer-file ./my-transformer.ts",
        description: "Include one you wrote",
      },
    ])
    .action((_opts, cmd) =>
      migrate.transformersList(
        cmd.optsWithGlobals() as Parameters<typeof migrate.transformersList>[0],
      ),
    );

  registerMigrateLogs(migrateCommand);
  registerMigrateSettings(migrateCommand);
}
