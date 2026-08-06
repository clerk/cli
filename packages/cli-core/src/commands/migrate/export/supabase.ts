/**
 * `clerk migrate export supabase` — read users straight out of `auth.users`.
 *
 * Ported from the standalone migration-tool's `src/export/supabase.ts`, on
 * `Bun.sql` instead of `pg`.
 *
 * The database rather than the Admin API because **`encrypted_password` only
 * exists here**. Supabase's API does not return password hashes, so an
 * API-based export forces every user to reset their password; this one carries
 * the bcrypt digests across.
 */

import { log } from "../../../lib/log.ts";
import { withGutter, withSpinner } from "../../../lib/spinner.ts";
import { exportLogger, getDateTimeStamp } from "../lib/logger.ts";
import { withDbClient, type DbClient } from "../lib/db.ts";
import { defaultOutputPath, reportExport, writeExportOutput } from "./shared.ts";
import { resolveDbUrl, type DbExportOptions } from "./db-options.ts";

/**
 * `display_name` is coalesced into `first_name` here rather than in the
 * transformer so a user who writes their own SQL sees the shape the
 * transformer expects.
 */
const EXPORT_QUERY = `
  SELECT
    id,
    email,
    email_confirmed_at,
    encrypted_password,
    phone,
    phone_confirmed_at,
    COALESCE(
      raw_user_meta_data->>'display_name',
      raw_user_meta_data->>'first_name',
      raw_user_meta_data->>'name'
    ) AS first_name,
    raw_user_meta_data->>'last_name' AS last_name,
    raw_user_meta_data,
    raw_app_meta_data,
    created_at
  FROM auth.users
  ORDER BY created_at
`;

type SupabaseRow = Record<string, unknown> & {
  id?: unknown;
  email?: string | null;
  encrypted_password?: string | null;
  raw_app_meta_data?: unknown;
};

/** Serializes values the JSON export cannot carry as-is. */
function normalizeRow(row: SupabaseRow): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(row)) {
    if (value === null || value === undefined) continue;
    // Postgres returns timestamps as Date objects; the transformer parses
    // strings, and JSON.stringify would otherwise bury the format difference.
    normalized[key] = value instanceof Date ? value.toISOString() : value;
  }

  return normalized;
}

export async function fetchSupabaseUsers(client: DbClient): Promise<SupabaseRow[]> {
  return client.query<SupabaseRow>(EXPORT_QUERY);
}

export function buildSupabaseExport(rows: SupabaseRow[], dateTime: string) {
  const users: Record<string, unknown>[] = [];
  const counts = { email: 0, emailConfirmed: 0, password: 0, phone: 0, firstName: 0, lastName: 0 };

  for (const row of rows) {
    const userId = String(row.id ?? "");
    try {
      users.push(normalizeRow(row));

      if (row.email) counts.email++;
      if (row.email_confirmed_at) counts.emailConfirmed++;
      if (row.encrypted_password) counts.password++;
      if (row.phone) counts.phone++;
      if (row.first_name) counts.firstName++;
      if (row.last_name) counts.lastName++;

      exportLogger({ userId, status: "success" }, dateTime);
    } catch (error) {
      exportLogger({ userId, status: "error", error: (error as Error).message }, dateTime);
    }
  }

  return {
    users,
    coverage: [
      { label: "have an email address", count: counts.email },
      { label: "have a confirmed email", count: counts.emailConfirmed },
      { label: "have a password hash", count: counts.password },
      { label: "have a phone number", count: counts.phone },
      { label: "have a first name", count: counts.firstName },
      { label: "have a last name", count: counts.lastName },
    ],
  };
}

export async function exportSupabase(options: DbExportOptions): Promise<void> {
  const dbUrl = await resolveDbUrl(options, {
    platform: "supabase",
    envVar: "SUPABASE_DB_URL",
    prompt: "Supabase Postgres connection string",
    hint: "Dashboard → Connect → Session pooler. Direct connections need the IPv4 add-on.",
  });

  await withGutter("Exporting users from Supabase", async () => {
    const dateTime = getDateTimeStamp();

    const rows = await withSpinner("Reading auth.users", () =>
      withDbClient(dbUrl, "supabase", fetchSupabaseUsers),
    );

    const { users, coverage } = buildSupabaseExport(rows, dateTime);
    const outputPath = writeExportOutput(users, options.output ?? defaultOutputPath("supabase"));

    reportExport({
      platform: "supabase",
      userCount: users.length,
      outputPath,
      coverage,
      transformerKey: "supabase",
    });

    if (users.length > 0) {
      log.info(
        "Password hashes are included — this is why the export reads the database rather than the Admin API.",
      );
    }
  });
}
