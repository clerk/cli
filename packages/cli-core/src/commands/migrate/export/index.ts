import type { Command } from "@commander-js/extra-typings";
import { throwUsageError } from "../../../lib/errors.ts";
import { select } from "../../../lib/listage.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { exportAuth0 } from "./auth0.ts";
import { exportAuthJs } from "./authjs.ts";
import { exportBetterAuth } from "./betterauth.ts";
import { exportClerk } from "./clerk.ts";
import { exportFirebase } from "./firebase.ts";
import { exportSupabase } from "./supabase.ts";
import { exportWorkOs } from "./workos.ts";
import type { DbExportOptions } from "./db-options.ts";
import { RUNS_DIR_DESCRIPTION, RUNS_DIR_FLAG } from "../lib/run-store.ts";
import { exportPlatformKeys, exportPlatforms, getExportPlatform } from "./registry.ts";
import { setTelemetryStage } from "../../../lib/telemetry.ts";
import { recordMigrateSource } from "../telemetry.ts";

/**
 * Bare `clerk migrate export` — pick a platform, then run its export.
 *
 * The picker is built from the registry, so a new platform appears without a
 * second place to update. Whatever the chosen platform needs beyond the
 * platform name, it prompts for itself.
 */
export async function exportPicker(options: Record<string, unknown> = {}): Promise<void> {
  if (options.json || isAgent() || !isHuman()) {
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

  setTelemetryStage("migrate_pick_platform");
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
  recordMigrateSource(platform);
  setTelemetryStage("migrate_export_read");

  await entry.run(options);
}

const handlers = {
  picker: exportPicker,
  clerk: exportClerk,
  auth0: exportAuth0,
  supabase: exportSupabase,
  authjs: exportAuthJs,
  betterauth: exportBetterAuth,
  firebase: exportFirebase,
  workos: exportWorkOs,
};

/** The platforms that read a database, which share `--db-url`. */
const DB_PLATFORMS = [
  {
    key: "supabase",
    summary: "Export users from a Supabase Postgres database",
    envVar: "SUPABASE_DB_URL",
    dbUrl: "Postgres connection string",
    example: "postgres://postgres:password@db.xxx.supabase.co:5432/postgres",
  },
  {
    key: "authjs",
    summary: "Export users from an Auth.js database",
    envVar: "AUTHJS_DB_URL",
    dbUrl: "Postgres, MySQL, libsql/Turso, or SQLite connection string",
    example: "mysql://user:password@127.0.0.1:3306/authjs",
    flags: [
      [
        "--trust-oauth-emails",
        "Mark the email of a user who signs in with OAuth verified; Auth.js leaves it unverified",
      ],
    ],
  },
  {
    key: "betterauth",
    summary: "Export users from a Better Auth database",
    envVar: "BETTERAUTH_DB_URL",
    dbUrl: "Postgres, MySQL, libsql/Turso, or SQLite connection string",
    example: "./db.sqlite",
  },
] as const;

/** Registers `export [platform]` under the `migrate` group. */
export function registerMigrateExport(migrateCommand: Command<[], Record<string, unknown>>): void {
  const exportCommand = migrateCommand
    .command("export")
    .description("Export users from an auth platform, ready for `clerk migrate import`")
    .setExamples([
      { command: "clerk migrate export", description: "Pick a platform interactively" },
      {
        command: "clerk migrate export clerk",
        description: "Export from a Clerk instance into a new run",
      },
      {
        command: "clerk migrate export auth0 --domain my-tenant.us.auth0.com --client-id …",
        description: "Export from an Auth0 tenant; asks for the secret, masked",
      },
    ])
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .option("--json", "Print the result as JSON; never prompts")
    .action(async (_opts, cmd) =>
      handlers.picker(cmd.optsWithGlobals() as Record<string, unknown>),
    );

  // The export is one JSON document, and the import reads a file by its
  // extension: an envelope written to users.ndjson could not be imported by
  // run ID. Checked before anything is read.
  exportCommand.hook("preAction", (_thisCommand, actionCommand) => {
    // The bare picker records both once a platform is chosen.
    if (actionCommand !== exportCommand) {
      recordMigrateSource(actionCommand.name());
      setTelemetryStage("migrate_export_read");
    }
    const { output } = actionCommand.opts() as { output?: unknown };
    if (typeof output === "string" && !output.toLowerCase().endsWith(".json")) {
      throwUsageError(
        `--output must end in .json: the export is one JSON document, and \`clerk migrate import\` reads a file by its extension. Got ${output}.`,
      );
    }
  });

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
        description: "Prompts for the instance to export from",
      },
      {
        command: "clerk migrate export clerk --secret-key sk_live_… --output prod-users.json",
        description: "Name the source instance outright, skipping the picker",
      },
    ])
    .action(async (_opts, cmd) =>
      handlers.clerk(cmd.optsWithGlobals() as Parameters<typeof handlers.clerk>[0]),
    );

  exportCommand
    .command("auth0")
    .description("Export users from an Auth0 tenant")
    .option(
      "--domain <domain>",
      "Auth0 tenant domain, e.g. my-tenant.us.auth0.com, not a custom domain",
    )
    .option("--client-id <id>", "Machine-to-machine application client ID")
    .option("--client-secret <secret>", "Machine-to-machine application client secret")
    .option("-o, --output <path>", "Write the export here instead of the run folder")
    .option("-y, --yes", "Do not prompt: fail on a rejected credential")
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .option("--json", "Print the result as JSON; never prompts")
    .setExamples([
      {
        command: "clerk migrate export auth0 --domain my-tenant.us.auth0.com --client-id …",
        description:
          "Export with the secret entered at a masked prompt, or from AUTH0_CLIENT_SECRET",
      },
      {
        command: "clerk migrate export auth0",
        description: "Read AUTH0_DOMAIN, AUTH0_CLIENT_ID, and AUTH0_CLIENT_SECRET, or prompt",
      },
    ])
    .action(async (_opts, cmd) =>
      handlers.auth0(cmd.optsWithGlobals() as Parameters<typeof handlers.auth0>[0]),
    );

  exportCommand
    .command("firebase")
    .description("Export users from a Firebase project")
    .option("--service-account <path>", "Path to a service account key JSON file")
    .option("-o, --output <path>", "Write the export here instead of the run folder")
    .option("-y, --yes", "Do not prompt: fail on a rejected credential")
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .option("--json", "Print the result as JSON; never prompts")
    .setExamples([
      {
        command: "clerk migrate export firebase --service-account ./service-account.json",
        description: "Export using a downloaded service account key",
      },
    ])
    .action(async (_opts, cmd) =>
      handlers.firebase(cmd.optsWithGlobals() as Parameters<typeof handlers.firebase>[0]),
    );

  exportCommand
    .command("workos")
    .description("Export users from a WorkOS tenant")
    .option("--api-key <key>", "WorkOS secret API key, the one starting `sk_`")
    .option(
      "--with-identities",
      "Also record each user's OAuth providers — one extra request per user",
    )
    .option("--no-with-identities", "Skip the OAuth provider fan-out without being asked")
    .option("-o, --output <path>", "Write the export here instead of the run folder")
    .option(
      "-y, --yes",
      "Do not prompt: fail on a rejected credential, and skip the OAuth provider fan-out unless --with-identities",
    )
    .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
    .option("--json", "Print the result as JSON; never prompts")
    .setExamples([
      {
        command: "clerk migrate export workos --api-key sk_…",
        description: "Export with an explicit API key",
      },
      {
        command: "clerk migrate export workos",
        description: "Read WORKOS_API_KEY, or prompt",
      },
    ])
    .action(async (_opts, cmd) =>
      handlers.workos(cmd.optsWithGlobals() as Parameters<typeof handlers.workos>[0]),
    );

  // Each takes exactly one connection string, so they are registered from a
  // table rather than near-identical blocks.
  for (const platform of DB_PLATFORMS) {
    const command = exportCommand
      .command(platform.key)
      .description(platform.summary)
      .option("--db-url <url>", platform.dbUrl)
      .option("-o, --output <path>", "Write the export here instead of the run folder")
      .option("-y, --yes", "Do not prompt: fail on a rejected credential")
      .option(RUNS_DIR_FLAG, RUNS_DIR_DESCRIPTION)
      .option("--json", "Print the result as JSON; never prompts");
    for (const [flag, description] of "flags" in platform ? platform.flags : []) {
      command.option(flag, description);
    }
    command
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
