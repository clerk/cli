/**
 * `clerk migrate export authjs` — read users out of an Auth.js database.
 *
 * Ported from the standalone migration-tool's `src/export/authjs.ts`, on the
 * `Bun.sql`/`bun:sqlite` client.
 *
 * Auth.js has no export tool and no single schema: the adapter decides the
 * table name, and Prisma's `User` differs from Drizzle's `user` only in
 * casing — which Postgres and SQLite treat as significant once quoted. The
 * export tries the documented casing first and falls back rather than making
 * the user find out from a driver error.
 */

import { withGutter, withSpinner } from "../../../lib/spinner.ts";
import { log } from "../../../lib/log.ts";
import type { UserLine } from "../lib/run-store.ts";
import { printTarget } from "../lib/target.ts";
import { exportValue, withDbClient, type DbClient } from "../lib/db.ts";
import { finishExport, startExportRun } from "./shared.ts";
import {
  promptDbUrl,
  resolveDbUrl,
  type DbExportOptions,
  type ResolveConfig,
} from "./db-options.ts";
import { withInputRetry } from "../lib/input-retry.ts";

/** Table names to try, in order. Prisma capitalizes; Drizzle does not. */
const TABLE_CANDIDATES = ["User", "user", "users"] as const;

/**
 * The tables to try on this database. On Postgres, `@auth/supabase-adapter`
 * keeps its own in the `next_auth` schema, off the default `search_path`:
 * tried first, since an app's own `public.users` could otherwise answer for it.
 */
function tableCandidates(client: DbClient): string[] {
  return client.dbType === "postgres"
    ? ["next_auth.users", ...TABLE_CANDIDATES]
    : [...TABLE_CANDIDATES];
}

type AuthJsRow = Record<string, unknown> & {
  id?: unknown;
  name?: string | null;
  email?: string | null;
  email_verified?: unknown;
  created_at?: unknown;
};

/**
 * The verified-email column, in the order tried: the current adapters' name,
 * then the legacy NextAuth `users` table's.
 */
const VERIFIED_COLUMNS = ["emailVerified", "email_verified"] as const;

/**
 * What each attempt reads, in order. Only the legacy table has a
 * `created_at`, and it may be gone: the second attempt drops it.
 */
const ATTEMPTS = [
  { verifiedColumn: "emailVerified", createdAt: false },
  { verifiedColumn: "email_verified", createdAt: true },
  { verifiedColumn: "email_verified", createdAt: false },
] as const;

/**
 * Every column is qualified with the table alias: SQLite reads an unqualified
 * double-quoted name that matches no column as a string literal, so a missing
 * `"emailVerified"` would come back as the text "emailVerified" on every row,
 * which reads as verified.
 */
export function buildAuthJsQuery(
  client: DbClient,
  table: string,
  verifiedColumn: (typeof VERIFIED_COLUMNS)[number] = "emailVerified",
  createdAt = false,
): string {
  const q = (identifier: string) => client.quote(identifier);
  // `next_auth.users` is a schema and a table, each quoted on its own.
  const from = table.split(".").map(q).join(".");
  return (
    `SELECT u.${q("id")}, u.${q("name")}, u.${q("email")}, u.${q(verifiedColumn)} AS ${q("email_verified")}` +
    (createdAt ? `, u.${q("created_at")}` : "") +
    ` FROM ${from} u ORDER BY u.${q("id")} ASC`
  );
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** True for an error that means "no such column". Postgres says "does not exist" for both. */
function isMissingColumn(error: unknown): boolean {
  return /no such column|column .* does not exist|unknown column/i.test(messageOf(error));
}

/** True for an error that means "wrong table name", not "broken connection". */
function isMissingTable(error: unknown): boolean {
  return /does not exist|no such table|doesn't exist|unknown table/i.test(messageOf(error));
}

/**
 * The name a table really has. SQLite matches a quoted name without case, so
 * the first candidate, `User`, answers for a Drizzle `user` table too.
 */
async function storedName(client: DbClient, table: string): Promise<string> {
  if (client.dbType !== "sqlite") return table;
  try {
    const [row] = await client.query<{ name: unknown }>(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${client.placeholder(1)} COLLATE NOCASE`,
      [table],
    );
    return typeof row?.name === "string" ? row.name : table;
  } catch {
    return table;
  }
}

/**
 * Reads the user table, trying each casing until one answers.
 *
 * A table that exists but lacks the columns is passed over too: Postgres
 * keeps a quoted `"User"` apart from `"user"`, and an app's own `User` table
 * must not hide Auth.js's. When nothing reads, the first column error is the
 * one thrown, since it names a table that was there.
 *
 * @returns The rows and the table they came from, so the run can say which.
 */
export async function fetchAuthJsUsers(
  client: DbClient,
): Promise<{ rows: AuthJsRow[]; table: string }> {
  let lastError: unknown;
  let columnError: unknown;

  const candidates = tableCandidates(client);
  for (const table of candidates) {
    for (const { verifiedColumn, createdAt } of ATTEMPTS) {
      try {
        const rows = await client.query<AuthJsRow>(
          buildAuthJsQuery(client, table, verifiedColumn, createdAt),
        );
        return { rows, table: await storedName(client, table) };
      } catch (error) {
        // The table is there: try the next shape of it.
        if (isMissingColumn(error)) {
          columnError ??= error;
          continue;
        }
        if (!isMissingTable(error)) throw error;
        lastError = error;
        break;
      }
    }
  }

  if (columnError) throw columnError;
  throw lastError instanceof Error
    ? new Error(`No Auth.js user table found. Tried ${candidates.join(", ")}. ${lastError.message}`)
    : new Error(`No Auth.js user table found. Tried ${candidates.join(", ")}.`);
}

export function buildAuthJsExport(rows: AuthJsRow[], record: (line: UserLine) => void = () => {}) {
  const users: Record<string, unknown>[] = [];
  const counts = { email: 0, emailVerified: 0, name: 0 };

  for (const row of rows) {
    const userId = String(row.id ?? "");
    const user: Record<string, unknown> = { id: userId };

    if (row.name) {
      user.name = row.name;
      counts.name++;
    }
    if (row.email) {
      user.email = row.email;
      counts.email++;
    }
    // A nullable timestamp, not a boolean: the transformer reads presence.
    // A zero date is no verification, as a number or as a driver's Date.
    const zeroDate = row.email_verified instanceof Date && row.email_verified.getTime() === 0;
    const verified = row.email_verified && !zeroDate ? exportValue(row.email_verified) : undefined;
    if (verified !== undefined) {
      user.email_verified = verified;
      counts.emailVerified++;
    }
    // Only a legacy NextAuth table has one: Auth.js's own schemas don't.
    const created = row.created_at ? exportValue(row.created_at) : undefined;
    if (created !== undefined) user.created_at = created;

    users.push(user);
    record({ sourceId: userId, status: "exported" });
  }

  return {
    users,
    coverage: [
      { label: "have an email address", count: counts.email },
      { label: "have a verified email", count: counts.emailVerified },
      { label: "have a name", count: counts.name },
    ],
  };
}

const AUTHJS_DB = {
  platform: "authjs",
  envVar: "AUTHJS_DB_URL",
  prompt: "Auth.js database connection string",
  hint: "Postgres, MySQL, libsql://… or a SQLite file — whichever your Auth.js adapter uses.",
} as const satisfies ResolveConfig;

export async function exportAuthJs(options: DbExportOptions): Promise<void> {
  const dbUrl = await resolveDbUrl(options, AUTHJS_DB);

  await withGutter("Exporting users from Auth.js", async () => {
    if (!options.json) printTarget({ platform: "authjs" });
    const {
      value: { rows, table },
    } = await withInputRetry(
      dbUrl,
      async () => promptDbUrl(AUTHJS_DB),
      async (connectionString) =>
        withSpinner("Reading the user table...", async () =>
          withDbClient(connectionString, "authjs", fetchAuthJsUsers),
        ),
      options,
    );
    log.info(`Read ${rows.length} row${rows.length === 1 ? "" : "s"} from ${table}.`);

    const run = await startExportRun(options, { platform: "authjs" });
    const { users, coverage } = buildAuthJsExport(rows, run.append);
    finishExport({ run, options, users, coverage });

    if (users.length > 0) {
      log.warn(
        "Auth.js core stores no passwords, so users arrive without one. That covers OAuth and email-link sign-in. " +
          "If the app also uses the Credentials provider, its passwords live in the app's own tables and were not exported: " +
          "migrate them separately, or have those users reset their password.",
      );
    }
  });
}
