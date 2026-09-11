import { createArgument } from "@commander-js/extra-typings";
import type { Command } from "@commander-js/extra-typings";
import { clean } from "./clean.ts";
import { convert } from "./convert.ts";
import { list } from "./list.ts";

const logs = { clean, convert, list };

/**
 * Registers `logs list|clean|convert` under the `migrate` group.
 *
 * Noun-verb, matching every other group in the CLI (`config pull`, `users
 * list`) rather than the standalone tool's `clean-logs`/`convert-logs`, which
 * were npm script names. Grouping also disambiguates the two deletes in this
 * tree: `migrate logs clean` removes local files, `migrate delete` removes
 * users from a Clerk instance.
 */
export function registerMigrateLogs(migrateCommand: Command<[], Record<string, unknown>>): void {
  const logsCommand = migrateCommand
    .command("logs")
    .description("Inspect, convert and clean up local migration logs")
    .setExamples([
      { command: "clerk migrate logs", description: "List the local migration logs" },
      { command: "clerk migrate logs clean -y", description: "Delete every migration log" },
      {
        command: "clerk migrate logs convert --all",
        description: "Convert every log to a JSON array",
      },
    ]);

  // Listing is read-only, so it is safe as the default for a bare
  // `clerk migrate logs`.
  logsCommand
    .command("list", { isDefault: true })
    .description("List the migration log files")
    .option("--json", "Output as JSON")
    .setExamples([
      { command: "clerk migrate logs list", description: "Show type, timestamp, size and entries" },
      { command: "clerk migrate logs list --json", description: "Machine-readable listing" },
    ])
    .action((_opts, cmd) => logs.list(cmd.optsWithGlobals() as Parameters<typeof logs.list>[0]));

  logsCommand
    .command("clean")
    .description("Delete the migration log files")
    .option("-y, --yes", "Skip the confirmation prompt")
    .setExamples([
      { command: "clerk migrate logs clean", description: "Delete after confirming" },
      { command: "clerk migrate logs clean -y", description: "Delete without prompting" },
    ])
    .action((_opts, cmd) => logs.clean(cmd.optsWithGlobals() as Parameters<typeof logs.clean>[0]));

  logsCommand
    .command("convert")
    .description("Convert NDJSON logs to JSON arrays for analysis")
    .addArgument(createArgument("[file...]", "Log files to convert. Omit to pick interactively."))
    .option("--all", "Convert every log file")
    .setExamples([
      { command: "clerk migrate logs convert --all", description: "Convert every log file" },
      {
        command: "clerk migrate logs convert migration-2026-01-01T12-00-00.log",
        description: "Convert one log file",
      },
      { command: "clerk migrate logs convert", description: "Pick files interactively" },
    ])
    .action((files, _opts, cmd) =>
      logs.convert({
        ...(cmd.optsWithGlobals() as Parameters<typeof logs.convert>[0]),
        files,
      }),
    );
}
