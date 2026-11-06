/**
 * SQL against the Supabase project, for the rows the admin API cannot make or
 * unmake: anonymous and SSO users, real passwordless users (an empty
 * `encrypted_password`), provider lists in `raw_app_meta_data`, and emptying
 * `auth.users` in one statement.
 *
 * Uses the Management API with a personal access token (SUPABASE_ACCESS_TOKEN,
 * database_write).
 */

export async function sql<T = Record<string, unknown>>(query: string): Promise<T[]> {
  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token)
    throw new Error(
      "SUPABASE_ACCESS_TOKEN is not set: a personal access token with database_write " +
        "(https://supabase.com/dashboard/account/tokens).",
    );
  // https://abcdefgh.supabase.co -> abcdefgh
  const ref = new URL(process.env.NEXT_PUBLIC_SUPABASE_URL!).hostname.split(".")[0];
  for (let attempt = 1; ; attempt++) {
    const response = await fetch(`https://api.supabase.com/v1/projects/${ref}/database/query`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ query }),
    });
    // The Management API allows ~120 requests/min; back off rather than fail.
    if (response.status === 429 && attempt < 6) {
      await new Promise((r) => setTimeout(r, 2000 * attempt));
      continue;
    }
    if (!response.ok) throw new Error(`SQL failed (${response.status}): ${await response.text()}`);
    return (await response.json()) as T[];
  }
}

/** A single-quoted SQL string literal. */
export const lit = (value: string) => `'${value.replaceAll("'", "''")}'`;

/** A jsonb literal. */
export const jsonb = (value: unknown) => `${lit(JSON.stringify(value))}::jsonb`;
