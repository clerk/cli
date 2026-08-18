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
import type { DbExportOptions } from "./db-options.ts";
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
  auth0: exportAuth0,
  supabase: exportSupabase,
  authjs: exportAuthJs,
  betterauth: exportBetterAuth,
  firebase: exportFirebase,
};

/** The three platforms that read a database, which share `--db-url`. */
const DB_PLATFORMS = [
  {
    key: "supabase",
    summary: "Export users from a Supabase Postgres database",
    envVar: "SUPABASE_DB_URL",
    example: "postgres://postgres:password@db.xxx.supabase.co:5432/postgres",
  },
  {
    key: "authjs",
    summary: "Export users from an Auth.js database",
    envVar: "AUTHJS_DB_URL",
    example: "mysql://user:password@127.0.0.1:3306/authjs",
  },
  {
    key: "betterauth",
    summary: "Export users from a Better Auth database",
    envVar: "BETTERAUTH_DB_URL",
    example: "./db.sqlite",
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
        command: "clerk migrate export clerk --output users.json",
        description: "Export from a Clerk instance",
      },
      {
        command:
          "clerk migrate export auth0 --domain my-tenant.us.auth0.com --client-id … --client-secret …",
        description: "Export from an Auth0 tenant",
      },
    ])
    .action((_opts, cmd) => handlers.picker(cmd.optsWithGlobals() as Record<string, unknown>));

  exportCommand
    .command("clerk")
    .description("Export users from a Clerk instance (default: ./exports/clerk-export.json)")
    .option("-o, --output <path>", "Where to write the export, relative to the current directory")
    .option("--secret-key <key>", "Backend API secret key to use")
    .option("--app <id>", "Application ID to target (works from any directory)")
    .option("--instance <id>", "Instance to target (dev, prod, or a full instance ID)")
    .setExamples([
      {
        command: "clerk migrate export clerk",
        description: "Export to ./exports/clerk-export.json",
      },
      {
        command: "clerk migrate export clerk --instance prod --output prod-users.json",
        description: "Export a specific instance to a chosen path",
      },
    ])
    .action((_opts, cmd) =>
      handlers.clerk(cmd.optsWithGlobals() as Parameters<typeof handlers.clerk>[0]),
    );

  exportCommand
    .command("auth0")
    .description("Export users from an Auth0 tenant (default: ./exports/auth0-export.json)")
    .option("--domain <domain>", "Auth0 tenant domain, e.g. my-tenant.us.auth0.com")
    .option("--client-id <id>", "Machine-to-machine application client ID")
    .option("--client-secret <secret>", "Machine-to-machine application client secret")
    .option("-o, --output <path>", "Where to write the export, relative to the current directory")
    .setExamples([
      {
        command:
          "clerk migrate export auth0 --domain my-tenant.us.auth0.com --client-id … --client-secret …",
        description: "Export with explicit credentials",
      },
      {
        command: "clerk migrate export auth0",
        description: "Read AUTH0_DOMAIN, AUTH0_CLIENT_ID and AUTH0_CLIENT_SECRET, or prompt",
      },
    ])
    .action((_opts, cmd) =>
      handlers.auth0(cmd.optsWithGlobals() as Parameters<typeof handlers.auth0>[0]),
    );

  exportCommand
    .command("firebase")
    .description("Export users from a Firebase project (default: ./exports/firebase-export.json)")
    .option("--service-account <path>", "Path to a service account key JSON file")
    .option("-o, --output <path>", "Where to write the export, relative to the current directory")
    .setExamples([
      {
        command: "clerk migrate export firebase --service-account ./service-account.json",
        description: "Export using a downloaded service account key",
      },
    ])
    .action((_opts, cmd) =>
      handlers.firebase(cmd.optsWithGlobals() as Parameters<typeof handlers.firebase>[0]),
    );

  // All three take exactly one connection string, so they are registered from
  // a table rather than three near-identical blocks.
  for (const platform of DB_PLATFORMS) {
    exportCommand
      .command(platform.key)
      .description(`${platform.summary} (default: ./exports/${platform.key}-export.json)`)
      .option("--db-url <url>", "Postgres, MySQL or SQLite connection string")
      .option("-o, --output <path>", "Where to write the export, relative to the current directory")
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
      .action((_opts, cmd) => handlers[platform.key](cmd.optsWithGlobals() as DbExportOptions));
  }
}
