import type { Command } from "@commander-js/extra-typings";
import { throwUsageError } from "../../../lib/errors.ts";
import { select } from "../../../lib/listage.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { exportClerk } from "./clerk.ts";
import { exportSupabase } from "./supabase.ts";
import type { DbExportOptions } from "./db-options.ts";
import { RUNS_DIR_DESCRIPTION, RUNS_DIR_FLAG } from "../lib/run-store.ts";
import { exportPlatformKeys, exportPlatforms, getExportPlatform } from "./registry.ts";

/**
 * Bare `clerk migrate export` — pick a platform, then run its export.
 *
 * The picker is built from the registry, so a new platform appears without a
 * second place to update. Whatever the chosen platform needs beyond the
 * platform name, it prompts for itself.
 */
export async function exportPicker(options: Record<string, unknown> = {}): Promise<void> {
  if (isAgent() || !isHuman()) {
    throwUsageError(
      `\`clerk migrate export\` needs a platform and cannot prompt here. Name one: ${exportPlatformKeys().join(", ")}.`,
      undefined,
      undefined,
      exportPlatforms.map((entry) => ({
        command: `clerk migrate export ${entry.key}`,
        description: entry.description,
      })),
    );
  }

  const platform = await select<string>({
    message: "Which platform are you exporting from?",
    choices: exportPlatforms.map((entry) => ({
      name: entry.label,
      value: entry.key,
      description: entry.description,
    })),
  });

  const entry = getExportPlatform(platform);
  // Unreachable via the picker; a guard so a registry edit cannot silently
  // produce a choice with nothing behind it.
  if (!entry) throwUsageError(`Unknown export platform "${platform}".`);

  await entry.run(options);
}

const handlers = {
  picker: exportPicker,
  clerk: exportClerk,
  supabase: exportSupabase,
};

/** The platforms that read a database, which share `--db-url`. */
const DB_PLATFORMS = [
  {
    key: "supabase",
    summary: "Export users from a Supabase Postgres database",
    envVar: "SUPABASE_DB_URL",
    example: "postgres://postgres:password@db.xxx.supabase.co:5432/postgres",
  },
] as const;

/** Registers `export [platform]` under the `migrate` group. */
export function registerMigrateExport(migrateCommand: Command<[], Record<string, unknown>>): void {
  const exportCommand = migrateCommand
    .command("export")
    .description("Export users from a source platform, ready for `clerk migrate import`")
    .setExamples([
      { command: "clerk migrate export", description: "Pick a platform interactively" },
      {
        command: "clerk migrate export clerk",
        description: "Export from a Clerk instance into a new run",
      },
      {
        command: "clerk migrate export supabase",
        description: "Export from a Supabase database",
      },
    ])
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .option("--json", "Print the result as JSON; never prompts")
    .action(async (_opts, cmd) =>
      handlers.picker(cmd.optsWithGlobals() as Record<string, unknown>),
    );

  exportCommand
    .command("clerk")
    .description("Export users from a Clerk instance")
    .option("-o, --output <path>", "Write the export here instead of the run folder")
    .option("-y, --yes", "Do not prompt: fail on a rejected credential")
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .option("--json", "Print the result as JSON; never prompts")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .setExamples([
      {
        command: "clerk migrate export clerk",
        description: "Prompts for the source instance and where to save the file",
      },
      {
        command: "clerk migrate export clerk --secret-key sk_live_… --output prod-users.json",
        description: "Name the source instance outright, skipping the picker",
      },
    ])
    .action(async (_opts, cmd) =>
      handlers.clerk(cmd.optsWithGlobals() as Parameters<typeof handlers.clerk>[0]),
    );

  // Each takes exactly one connection string, so they are registered from a
  // table rather than near-identical blocks.
  for (const platform of DB_PLATFORMS) {
    exportCommand
      .command(platform.key)
      .description(platform.summary)
      .option("--db-url <url>", "Postgres, MySQL, libsql/Turso or SQLite connection string")
      .option("-o, --output <path>", "Write the export here instead of the run folder")
      .option("-y, --yes", "Do not prompt: fail on a rejected credential")
      .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
      .option("--json", "Print the result as JSON; never prompts")
      .setExamples([
        {
          command: `clerk migrate export ${platform.key} --db-url "${platform.example}"`,
          description: "Export from an explicit database",
        },
        {
          command: `clerk migrate export ${platform.key}`,
          description: `Read ${platform.envVar}, or prompt`,
        },
      ])
      .action(async (_opts, cmd) =>
        handlers[platform.key](cmd.optsWithGlobals() as DbExportOptions),
      );
  }
}
