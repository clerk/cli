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
import { finishExport, startExportRun, type ExportSection } from "./shared.ts";
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
 * @returns The rows; `table`, the candidate that answered, which names the
 *   account table beside it; and `storedName`, the table as the database
 *   holds it, for the run to say which it read. They differ only in case, on
 *   SQLite.
 */
export async function fetchAuthJsUsers(
  client: DbClient,
): Promise<{ rows: AuthJsRow[]; table: string; storedName: string }> {
  let lastError: unknown;
  let columnError: unknown;

  const candidates = tableCandidates(client);
  for (const table of candidates) {
    for (const { verifiedColumn, createdAt } of ATTEMPTS) {
      try {
        const rows = await client.query<AuthJsRow>(
          buildAuthJsQuery(client, table, verifiedColumn, createdAt),
        );
        return { rows, table, storedName: await storedName(client, table) };
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

/**
 * The account table beside each user table: the same adapter names both, so
 * Prisma's `User` sits with `Account`, Drizzle's `user` with `account`.
 */
const ACCOUNT_TABLES: Record<string, string> = {
  "next_auth.users": "next_auth.accounts",
  User: "Account",
  user: "account",
  users: "accounts",
};

/** The current adapters' account columns, then the legacy NextAuth table's. */
const ACCOUNT_COLUMNS = [
  { userId: "userId", provider: "provider", type: "type" },
  { userId: "user_id", provider: "provider_id", type: "provider_type" },
] as const;

/** Account types that are an OAuth sign-in; `email` and `credentials` are not. */
const OAUTH_TYPES = new Set(["oauth", "oidc"]);

/**
 * Each user's OAuth providers, from the account table beside `userTable`, by
 * Auth.js provider ID (`github`, `google`).
 *
 * @returns `undefined` when there is no account table to read: the export
 *   then says it could not tell who signed in with OAuth.
 */
export async function fetchAuthJsAccounts(
  client: DbClient,
  userTable: string,
): Promise<Map<string, string[]> | undefined> {
  const table = ACCOUNT_TABLES[userTable];
  if (!table) return undefined;
  const q = (identifier: string) => client.quote(identifier);
  const from = table.split(".").map(q).join(".");
  for (const columns of ACCOUNT_COLUMNS) {
    try {
      // Qualified for the reason buildAuthJsQuery gives.
      const rows = await client.query<{ user_id: unknown; provider: unknown; type: unknown }>(
        `SELECT a.${q(columns.userId)} AS ${q("user_id")}, a.${q(columns.provider)} AS ${q("provider")}, ` +
          `a.${q(columns.type)} AS ${q("type")} FROM ${from} a`,
      );
      const providers = new Map<string, string[]>();
      for (const row of rows) {
        if (typeof row.provider !== "string" || !OAUTH_TYPES.has(String(row.type))) continue;
        const userId = String(row.user_id ?? "");
        const own = providers.get(userId) ?? [];
        if (!own.includes(row.provider)) own.push(row.provider);
        providers.set(userId, own);
      }
      return providers;
    } catch (error) {
      if (isMissingColumn(error)) continue;
      if (isMissingTable(error)) return undefined;
      throw error;
    }
  }
  return undefined;
}

export type AuthJsExportOptions = {
  /** Each user's OAuth providers; absent when the account table could not be read. */
  accounts?: Map<string, string[]>;
  /** Mark the email of a user with an OAuth account verified. */
  trustOauthEmails?: boolean;
  /** The verification time written for a trusted email. */
  now?: string;
};

export function buildAuthJsExport(
  rows: AuthJsRow[],
  record: (line: UserLine) => void = () => {},
  options: AuthJsExportOptions = {},
) {
  const users: Record<string, unknown>[] = [];
  const counts = { email: 0, emailVerified: 0, name: 0, oauthUnverified: 0, trusted: 0 };
  const byProvider = new Map<string, number>();
  const now = options.now ?? new Date().toISOString();

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
    const providers = options.accounts?.get(userId) ?? [];
    if (providers.length > 0) {
      user.providers = providers;
      for (const provider of providers) {
        byProvider.set(provider, (byProvider.get(provider) ?? 0) + 1);
      }
    }
    if (verified !== undefined) {
      user.email_verified = verified;
      counts.emailVerified++;
    } else if (row.email && providers.length > 0) {
      // Auth.js creates an OAuth user with `emailVerified: null`, so their
      // address arrives unverified unless the operator trusts the provider.
      if (options.trustOauthEmails) {
        user.email_verified = now;
        counts.emailVerified++;
        counts.trusted++;
      } else counts.oauthUnverified++;
    }
    // Only a legacy NextAuth table has one: Auth.js's own schemas don't.
    const created = row.created_at ? exportValue(row.created_at) : undefined;
    if (created !== undefined) user.created_at = created;

    users.push(user);
    record({ sourceId: userId, status: "exported" });
  }

  const sections: ExportSection[] = options.accounts
    ? [
        {
          title: "OAuth providers",
          // Busiest first; alphabetical within a tie, so runs print alike.
          items: [...byProvider]
            .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
            .map(([label, count]) => ({ label, count })),
        },
      ]
    : [];

  return {
    users,
    coverage: [
      { label: "have an email address", count: counts.email },
      { label: "have a verified email", count: counts.emailVerified },
      { label: "have a name", count: counts.name },
    ],
    sections: sections.filter((section) => section.items.length > 0),
    oauthUnverified: counts.oauthUnverified,
    trusted: counts.trusted,
  };
}

const AUTHJS_DB = {
  platform: "authjs",
  envVar: "AUTHJS_DB_URL",
  prompt: "Auth.js database connection string",
  hint: "Postgres, MySQL, libsql://… or a SQLite file — whichever your Auth.js adapter uses.",
} as const satisfies ResolveConfig;

export async function exportAuthJs(
  options: DbExportOptions & { trustOauthEmails?: boolean },
): Promise<void> {
  const dbUrl = await resolveDbUrl(options, AUTHJS_DB);

  await withGutter("Exporting users from Auth.js", async () => {
    if (!options.json) printTarget({ platform: "authjs" });
    const {
      value: { rows, table, storedName: tableName, accounts },
    } = await withInputRetry(
      dbUrl,
      async () => promptDbUrl(AUTHJS_DB),
      async (connectionString) =>
        withSpinner("Reading the user and account tables...", async () =>
          withDbClient(connectionString, "authjs", async (client) => {
            const found = await fetchAuthJsUsers(client);
            return { ...found, accounts: await fetchAuthJsAccounts(client, found.table) };
          }),
        ),
      options,
    );
    log.info(`Read ${rows.length} row${rows.length === 1 ? "" : "s"} from ${tableName}.`);

    const run = await startExportRun(options, { platform: "authjs" });
    const { users, coverage, sections, oauthUnverified, trusted } = buildAuthJsExport(
      rows,
      run.append,
      { ...(accounts ? { accounts } : {}), trustOauthEmails: options.trustOauthEmails },
    );
    finishExport({ run, options, users, coverage, sections });

    if (users.length > 0) {
      log.warn(
        "Auth.js core stores no passwords, so users arrive without one, as OAuth and email-link users never had one. " +
          "If the app also uses the Credentials provider, its passwords live wherever the app stores them, which the export does not read: " +
          "migrate them separately, or have those users reset their password.",
      );
    }
    if (!accounts && users.length > 0) {
      log.warn(
        `No account table beside ${tableName}, so the export could not tell who signs in with OAuth. ` +
          "Auth.js leaves an OAuth user's email unverified, and Clerk won't link a social sign-in to an unverified email.",
      );
    }
    if (oauthUnverified > 0) {
      log.warn(
        `${oauthUnverified} user${oauthUnverified === 1 ? " signs" : "s sign"} in with OAuth and ${oauthUnverified === 1 ? "has" : "have"} an unverified email, ` +
          "as Auth.js leaves it. An instance that requires an email rejects them, and on one that doesn't, Clerk won't link " +
          "their social sign-in to the imported user, so it creates a second one. If every provider you use verifies " +
          "addresses, export again with --trust-oauth-emails to mark them verified.",
      );
    }
    if (trusted > 0) {
      log.warn(
        `Marked ${trusted} email${trusted === 1 ? "" : "s"} verified because the user signs in with OAuth (--trust-oauth-emails). ` +
          "A provider that never verified an address lets whoever holds it claim that account in Clerk.",
      );
    }
  });
}
