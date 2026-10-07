/**
 * `clerk migrate export betterauth` — read users out of a Better Auth database.
 *
 * Ported from the standalone migration-tool's `src/export/betterauth.ts`, on
 * the `Bun.sql`/`bun:sqlite` client.
 *
 * Better Auth's schema depends on which plugins are enabled, so the columns
 * are **detected from the schema** rather than asked for: the username plugin
 * adds `username`, admin adds `banned`, phone-number adds `phoneNumber`,
 * anonymous adds `isAnonymous`, and
 * so on. Selecting a column that is not there fails the whole query, and
 * asking the user which plugins they run is a question their database can
 * already answer.
 *
 * Passwords live on the `account` row for the credential provider, not on the
 * user, which is why the export joins.
 */

import { log } from "../../../lib/log.ts";
import { withGutter, withSpinner } from "../../../lib/spinner.ts";
import type { UserLine } from "../lib/run-store.ts";
import { printTarget } from "../lib/target.ts";
import { withDbClient, type DbClient } from "../lib/db.ts";
import { finishExport, startExportRun } from "./shared.ts";
import {
  promptDbUrl,
  resolveDbUrl,
  type DbExportOptions,
  type ResolveConfig,
} from "./db-options.ts";
import { withInputRetry } from "../lib/input-retry.ts";

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
  "isAnonymous",
] as const;

export type PluginColumn = (typeof PLUGIN_COLUMNS)[number];

/** Columns every Better Auth install has. */
const CORE_COLUMNS = ["id", "email", "emailVerified", "name", "createdAt", "updatedAt"] as const;

/** How one Better Auth database names its tables and columns. */
export type BetterAuthSchema = {
  userTable: string;
  accountTable: string;
  /**
   * The column for a field. Better Auth's Drizzle generator writes snake_case
   * (`email_verified`) unless the project sets `camelCase: true`; its Kysely
   * and Prisma setups keep camelCase.
   */
  column: (field: string) => string;
  /** The plugin columns this database has. */
  plugins: Set<PluginColumn>;
};

/** `emailVerified` → `email_verified`, as Better Auth's Drizzle generator does it. */
function toSnakeCase(field: string): string {
  return field
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z\d])([A-Z])/g, "$1_$2")
    .toLowerCase();
}

/**
 * Every column of a table, or an empty set when there is no such table.
 *
 * SQLite has no `information_schema`, so it goes through `PRAGMA` — and the
 * PRAGMA takes the table name inline rather than as a bind parameter.
 */
async function tableColumns(client: DbClient, table: string): Promise<Set<string>> {
  if (client.dbType === "sqlite") {
    const rows = await client.query<{ name: string }>(`PRAGMA table_info(${client.quote(table)})`);
    return new Set(rows.map((row) => row.name));
  }
  const scope = client.dbType === "mysql" ? "DATABASE()" : "current_schema()";
  const rows = await client.query<{ column_name?: string; COLUMN_NAME?: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = ${client.placeholder(1)} AND table_schema = ${scope}`,
    [table],
  );
  // MySQL 8 answers with an upper-case column label.
  return new Set(rows.map((row) => row.column_name ?? row.COLUMN_NAME ?? ""));
}

/** Table names to try, in order: Better Auth's default, then `usePlural: true`. */
const TABLE_CANDIDATES = [
  ["user", "account"],
  ["users", "accounts"],
] as const;

/**
 * Asks the database how it names Better Auth's tables and columns, and which
 * plugin columns it has. Selecting a column that is not there fails the whole
 * query, so nothing is assumed.
 */
export async function detectSchema(client: DbClient): Promise<BetterAuthSchema> {
  for (const [userTable, accountTable] of TABLE_CANDIDATES) {
    const columns = await tableColumns(client, userTable);
    if (columns.size === 0) continue;
    const snake = !columns.has("emailVerified") && columns.has("email_verified");
    const column = (field: string) => (snake ? toSnakeCase(field) : field);
    const plugins = new Set(PLUGIN_COLUMNS.filter((field) => columns.has(column(field))));
    return { userTable, accountTable, column, plugins };
  }
  // No table found: the query names the default, and its "no such table"
  // error carries the hint.
  return {
    userTable: "user",
    accountTable: "account",
    column: (field) => field,
    plugins: new Set(),
  };
}

/**
 * Builds the SELECT, including only the plugin columns that exist. Each column
 * comes back under its camelCase name, however the database spells it.
 *
 * @param schema - From {@link detectSchema}.
 */
export function buildBetterAuthQuery(client: DbClient, schema: BetterAuthSchema): string {
  const q = (identifier: string) => client.quote(identifier);
  const { column } = schema;
  const select = (field: string) =>
    column(field) === field ? `u.${q(field)}` : `u.${q(column(field))} AS ${q(field)}`;
  const selected = [
    ...CORE_COLUMNS.map(select),
    ...PLUGIN_COLUMNS.filter((field) => schema.plugins.has(field)).map(select),
  ];

  // LEFT JOIN, not INNER: a user who only ever signed in with OAuth has no
  // credential account, and dropping them would silently shrink the export.
  return (
    `SELECT ${selected.join(", ")}, a.${q("password")} AS ${q("password_hash")} ` +
    `FROM ${q(schema.userTable)} u ` +
    `LEFT JOIN ${q(schema.accountTable)} a ON a.${q(column("userId"))} = u.${q("id")} ` +
    `AND a.${q(column("providerId"))} = 'credential' ` +
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

export function buildBetterAuthExport(
  rows: BetterAuthRow[],
  record: (line: UserLine) => void = () => {},
) {
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
    record({ sourceId: userId, status: "exported" });
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

const BETTERAUTH_DB = {
  platform: "betterauth",
  envVar: "BETTERAUTH_DB_URL",
  prompt: "Better Auth database connection string",
  hint: "Postgres, MySQL, libsql://… or a SQLite file — whichever your Better Auth install uses.",
} as const satisfies ResolveConfig;

export async function exportBetterAuth(options: DbExportOptions): Promise<void> {
  const dbUrl = await resolveDbUrl(options, BETTERAUTH_DB);

  await withGutter("Exporting users from Better Auth", async () => {
    if (!options.json) printTarget({ platform: "betterauth" });
    const {
      value: { rows, plugins },
    } = await withInputRetry(
      dbUrl,
      async () => promptDbUrl(BETTERAUTH_DB),
      async (connectionString) =>
        withSpinner("Reading the user table...", async () =>
          withDbClient(connectionString, "betterauth", async (client) => {
            const schema = await detectSchema(client);
            const rows = await client.query<BetterAuthRow>(buildBetterAuthQuery(client, schema));
            return { rows, plugins: schema.plugins };
          }),
        ),
      options,
    );

    log.info(
      plugins.size > 0
        ? `Detected plugin columns: ${[...plugins].join(", ")}.`
        : "No plugin columns detected; exporting the core user fields.",
    );

    const run = await startExportRun(options, { platform: "betterauth" });
    const { users, coverage } = buildBetterAuthExport(rows, run.append);
    finishExport({ run, options, users, coverage });
  });
}
