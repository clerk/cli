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

/**
 * Only the metadata's own `first_name` and `last_name` are pulled out as
 * columns. A `display_name`, `full_name` or OAuth `name` stays in
 * `raw_user_meta_data` for the Supabase source to split, which it does only
 * when `first_name` is empty: coalescing them in here would keep "Jane Doe"
 * as one first name, and let a display name outrank a real first name.
 */
const EXPORT_QUERY = `
  SELECT
    id,
    email,
    email_confirmed_at,
    encrypted_password,
    phone,
    phone_confirmed_at,
    raw_user_meta_data->>'first_name' AS first_name,
    raw_user_meta_data->>'last_name' AS last_name,
    raw_user_meta_data,
    raw_app_meta_data,
    banned_until,
    -- Through to_jsonb so an older auth.users without the column still reads.
    to_jsonb(u)->>'deleted_at' AS deleted_at,
    created_at
  FROM auth.users u
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

export function buildSupabaseExport(
  rows: SupabaseRow[],
  record: (line: UserLine) => void = () => {},
) {
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

      record({ sourceId: userId, status: "exported" });
    } catch (error) {
      record({ sourceId: userId, status: "skipped", error: (error as Error).message });
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

const SUPABASE_DB = {
  platform: "supabase",
  envVar: "SUPABASE_DB_URL",
  prompt: "Supabase Postgres connection string",
  hint: "Dashboard → Connect → Session pooler. Direct connections need the IPv4 add-on.",
} as const satisfies ResolveConfig;

export async function exportSupabase(options: DbExportOptions): Promise<void> {
  const dbUrl = await resolveDbUrl(options, SUPABASE_DB);

  await withGutter("Exporting users from Supabase", async () => {
    if (!options.json) printTarget({ platform: "supabase" });
    const { value: rows } = await withInputRetry(
      dbUrl,
      async () => promptDbUrl(SUPABASE_DB),
      async (connectionString) =>
        withSpinner("Reading auth.users...", async () =>
          withDbClient(connectionString, "supabase", fetchSupabaseUsers),
        ),
      options,
    );

    const run = await startExportRun(options, { platform: "supabase" });
    const { users, coverage } = buildSupabaseExport(rows, run.append);
    finishExport({ run, options, users, coverage });

    if (users.length > 0) {
      log.info(
        "Password hashes are included — this is why the export reads the database rather than the Admin API.",
      );
    }
  });
}
