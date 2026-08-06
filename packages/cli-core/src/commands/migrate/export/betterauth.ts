/**
 * `clerk migrate export betterauth` — read users out of a Better Auth database.
 *
 * Ported from the standalone migration-tool's `src/export/betterauth.ts`, on
 * the `Bun.sql`/`bun:sqlite` client.
 *
 * Better Auth's schema depends on which plugins are enabled, so the columns
 * are **detected from the schema** rather than asked for: the username plugin
 * adds `username`, admin adds `banned`, phone-number adds `phoneNumber`, and
 * so on. Selecting a column that is not there fails the whole query, and
 * asking the user which plugins they run is a question their database can
 * already answer.
 *
 * Passwords live on the `account` row for the credential provider, not on the
 * user, which is why the export joins.
 */

import { log } from "../../../lib/log.ts";
import { withGutter, withSpinner } from "../../../lib/spinner.ts";
import { exportLogger, getDateTimeStamp } from "../lib/logger.ts";
import { withDbClient, type DbClient } from "../lib/db.ts";
import { defaultOutputPath, reportExport, writeExportOutput } from "./shared.ts";
import { resolveDbUrl, type DbExportOptions } from "./db-options.ts";

/** Columns a Better Auth plugin adds to the user table. */
export const PLUGIN_COLUMNS = [
  "username",
  "displayUsername",
  "phoneNumber",
  "phoneNumberVerified",
  "role",
  "banned",
  "banReason",
  "banExpires",
  "twoFactorEnabled",
] as const;

export type PluginColumn = (typeof PLUGIN_COLUMNS)[number];

/** Columns every Better Auth install has. */
const CORE_COLUMNS = ["id", "email", "emailVerified", "name", "createdAt", "updatedAt"] as const;

/**
 * Asks the schema which plugin columns exist.
 *
 * SQLite has no `information_schema`, so it goes through `PRAGMA` — and the
 * PRAGMA takes the table name inline rather than as a bind parameter.
 */
export async function detectPluginColumns(client: DbClient): Promise<Set<PluginColumn>> {
  const present = new Set<PluginColumn>();

  if (client.dbType === "sqlite") {
    const rows = await client.query<{ name: string }>(`PRAGMA table_info(${client.quote("user")})`);
    const columns = new Set(rows.map((row) => row.name));
    for (const column of PLUGIN_COLUMNS) {
      if (columns.has(column)) present.add(column);
    }
    return present;
  }

  const scope = client.dbType === "mysql" ? "DATABASE()" : "current_schema()";
  const placeholders = PLUGIN_COLUMNS.map((_, index) => client.placeholder(index + 1)).join(", ");

  const rows = await client.query<{ column_name?: string; COLUMN_NAME?: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'user' AND table_schema = ${scope}
       AND column_name IN (${placeholders})`,
    [...PLUGIN_COLUMNS],
  );

  for (const row of rows) {
    // MySQL 8 answers with an upper-case column label.
    const name = (row.column_name ?? row.COLUMN_NAME) as PluginColumn | undefined;
    if (name && (PLUGIN_COLUMNS as readonly string[]).includes(name)) present.add(name);
  }

  return present;
}

/**
 * Builds the SELECT, including only the plugin columns that exist.
 *
 * @param pluginColumns - From {@link detectPluginColumns}.
 */
export function buildBetterAuthQuery(client: DbClient, pluginColumns: Set<PluginColumn>): string {
  const q = (identifier: string) => client.quote(identifier);
  const selected = [
    ...CORE_COLUMNS.map((column) => `u.${q(column)}`),
    ...PLUGIN_COLUMNS.filter((column) => pluginColumns.has(column)).map(
      (column) => `u.${q(column)}`,
    ),
  ];

  // LEFT JOIN, not INNER: a user who only ever signed in with OAuth has no
  // credential account, and dropping them would silently shrink the export.
  return (
    `SELECT ${selected.join(", ")}, a.${q("password")} AS ${q("password_hash")} ` +
    `FROM ${q("user")} u ` +
    `LEFT JOIN ${q("account")} a ON a.${q("userId")} = u.${q("id")} ` +
    `AND a.${q("providerId")} = 'credential' ` +
    `ORDER BY u.${q("id")} ASC`
  );
}

type BetterAuthRow = Record<string, unknown> & { id?: unknown };

/** Renames the schema's camelCase onto what the betterauth transformer reads. */
const FIELD_ALIASES: Record<string, string> = {
  id: "user_id",
  emailVerified: "email_verified",
  phoneNumber: "phone_number",
  phoneNumberVerified: "phone_number_verified",
  displayUsername: "display_username",
  createdAt: "created_at",
  updatedAt: "updated_at",
};

export function buildBetterAuthExport(rows: BetterAuthRow[], dateTime: string) {
  const users: Record<string, unknown>[] = [];
  const counts = { email: 0, emailVerified: 0, password: 0, name: 0, username: 0, phone: 0 };

  for (const row of rows) {
    const userId = String(row.id ?? "");
    const user: Record<string, unknown> = {};

    for (const [key, value] of Object.entries(row)) {
      if (value === null || value === undefined) continue;
      user[FIELD_ALIASES[key] ?? key] = value instanceof Date ? value.toISOString() : value;
    }

    if (row.email) counts.email++;
    if (row.emailVerified) counts.emailVerified++;
    if (row.password_hash) counts.password++;
    if (row.name) counts.name++;
    if (row.username) counts.username++;
    if (row.phoneNumber) counts.phone++;

    users.push(user);
    exportLogger({ userId, status: "success" }, dateTime);
  }

  return {
    users,
    coverage: [
      { label: "have an email address", count: counts.email },
      { label: "have a verified email", count: counts.emailVerified },
      { label: "have a password hash", count: counts.password },
      { label: "have a name", count: counts.name },
      { label: "have a username", count: counts.username },
      { label: "have a phone number", count: counts.phone },
    ],
  };
}

export async function exportBetterAuth(options: DbExportOptions): Promise<void> {
  const dbUrl = await resolveDbUrl(options, {
    platform: "betterauth",
    envVar: "BETTERAUTH_DB_URL",
    prompt: "Better Auth database connection string",
    hint: "Postgres, MySQL or a SQLite file — whichever your Better Auth install uses.",
  });

  await withGutter("Exporting users from Better Auth", async () => {
    const dateTime = getDateTimeStamp();

    const { rows, plugins } = await withSpinner("Reading the user table", () =>
      withDbClient(dbUrl, "betterauth", async (client) => {
        const plugins = await detectPluginColumns(client);
        const rows = await client.query<BetterAuthRow>(buildBetterAuthQuery(client, plugins));
        return { rows, plugins };
      }),
    );

    log.info(
      plugins.size > 0
        ? `Detected plugin columns: ${[...plugins].join(", ")}.`
        : "No plugin columns detected; exporting the core user fields.",
    );

    const { users, coverage } = buildBetterAuthExport(rows, dateTime);
    const outputPath = writeExportOutput(users, options.output ?? defaultOutputPath("betterauth"));

    reportExport({
      platform: "betterauth",
      userCount: users.length,
      outputPath,
      coverage,
      transformerKey: "betterauth",
    });
  });
}
