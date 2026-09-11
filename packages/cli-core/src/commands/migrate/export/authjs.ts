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
import { exportLogger, startLogging } from "../lib/logger.ts";
import { withDbClient, type DbClient } from "../lib/db.ts";
import { reportExport, resolveOutputPath, writeExportOutput } from "./shared.ts";
import { resolveDbUrl, type DbExportOptions } from "./db-options.ts";

/** Table names to try, in order. Prisma capitalizes; Drizzle does not. */
const TABLE_CANDIDATES = ["User", "user", "users"] as const;

type AuthJsRow = Record<string, unknown> & {
  id?: unknown;
  name?: string | null;
  email?: string | null;
  email_verified?: unknown;
};

export function buildAuthJsQuery(client: DbClient, table: string): string {
  const q = (identifier: string) => client.quote(identifier);
  return (
    `SELECT ${q("id")}, ${q("name")}, ${q("email")}, ${q("emailVerified")} AS ${q("email_verified")} ` +
    `FROM ${q(table)} ORDER BY ${q("id")} ASC`
  );
}

/** True for an error that means "wrong table name", not "broken connection". */
function isMissingTable(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /does not exist|no such table|doesn't exist|unknown table/i.test(message);
}

/**
 * Reads the user table, trying each casing until one answers.
 *
 * @returns The rows and the table they came from, so the run can say which.
 */
export async function fetchAuthJsUsers(
  client: DbClient,
): Promise<{ rows: AuthJsRow[]; table: string }> {
  let lastError: unknown;

  for (const table of TABLE_CANDIDATES) {
    try {
      return { rows: await client.query<AuthJsRow>(buildAuthJsQuery(client, table)), table };
    } catch (error) {
      if (!isMissingTable(error)) throw error;
      lastError = error;
    }
  }

  throw lastError instanceof Error
    ? new Error(
        `No Auth.js user table found. Tried ${TABLE_CANDIDATES.join(", ")}. ${lastError.message}`,
      )
    : new Error(`No Auth.js user table found. Tried ${TABLE_CANDIDATES.join(", ")}.`);
}

export function buildAuthJsExport(rows: AuthJsRow[], dateTime: string) {
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
    if (row.email_verified) {
      user.email_verified =
        row.email_verified instanceof Date ? row.email_verified.toISOString() : row.email_verified;
      counts.emailVerified++;
    }

    users.push(user);
    exportLogger({ userId, status: "success" }, dateTime);
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

export async function exportAuthJs(options: DbExportOptions): Promise<void> {
  const dbUrl = await resolveDbUrl(options, {
    platform: "authjs",
    envVar: "AUTHJS_DB_URL",
    prompt: "Auth.js database connection string",
    hint: "Postgres, MySQL or a SQLite file — whichever your Auth.js adapter uses.",
  });

  const destination = await resolveOutputPath("authjs", options.output);

  await withGutter("Exporting users from Auth.js", async ({ setNextSteps }) => {
    const dateTime = await startLogging();

    const { rows, table } = await withSpinner("Reading the user table...", () =>
      withDbClient(dbUrl, "authjs", fetchAuthJsUsers),
    );
    log.info(`Read ${rows.length} row${rows.length === 1 ? "" : "s"} from ${table}.`);

    const { users, coverage } = buildAuthJsExport(rows, dateTime);
    const outputPath = writeExportOutput(users, destination);

    setNextSteps(
      reportExport({
        platform: "authjs",
        userCount: users.length,
        outputPath,
        coverage,
        transformerKey: "authjs",
      }),
    );

    if (users.length > 0) {
      log.warn(
        "Auth.js core stores no passwords — its users sign in with OAuth or email links, so they arrive without credentials and will use the same providers in Clerk.",
      );
    }
  });
}
