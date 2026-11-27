/**
 * Seeds a hosted Supabase project from data/users.json using the service-role
 * key. Users are created pre-confirmed so they can sign in immediately.
 *
 * Phone numbers are stored on the account even though hosted Supabase cannot
 * send an SMS without an external provider — the data is there to migrate, the
 * interactive flow just is not available.
 *
 * The admin API cannot make every shape a real project holds, so a second pass
 * goes through SQL (lib/supabase.ts, needs SUPABASE_ACCESS_TOKEN):
 *   - passwordless users: createUser stores a random password when given none,
 *     where a real magic-link/OTP/OAuth signup stores '' — so it is blanked
 *   - OAuth users: `raw_app_meta_data.providers`, which the CLI reads
 *   - anonymous users (no email or phone) and SSO users (a duplicate email
 *     with is_sso_user) are inserted directly
 * Soft-deleted users go through the real path, admin.deleteUser(id, true).
 *
 * Run: bun seed.ts -p supabase
 */
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "node:crypto";
import { jsonb, lit, sql } from "./lib/supabase";
import { loadUsers, pool, progressBar, reportFailures, type SeedUser } from "./lib/users";

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const { seedPassword, users } = loadUsers();

/** The seed password as argon2id (m=19456,t=2,p=1), the same fixture seed-turso.ts uses. */
const ARGON2ID =
  "$argon2id$v=19$m=19456,t=2,p=1$bWlncmF0aW9uLXRlc3Qtc2FsdC0xNmI$gBbnEhvXQQCPhOB0CWeS82tBRGEQX2Lxu/aAZhtFEsU";

const userMetadata = (u: SeedUser) => ({
  seed_id: u.id,
  username: u.username,
  full_name: u.fullName,
  first_name: u.firstName,
  last_name: u.lastName,
  ...u.metadata?.user,
});

function password(u: SeedUser) {
  if (!u.hasPassword) return {};
  if (!u.passwordFormat || u.passwordFormat === "bcrypt") return { password: seedPassword };
  if (u.passwordFormat === "argon2id") return { password_hash: ARGON2ID };
  throw new Error(`Supabase seeding has no "${u.passwordFormat}" password format`);
}

const ids = new Map<SeedUser, string>();

async function createUser(u: SeedUser) {
  const { data, error } = await supabase.auth.admin.createUser({
    email: u.email ?? undefined,
    phone: u.phone ?? undefined,
    ...password(u),
    email_confirm: u.emailVerified,
    phone_confirm: u.phoneVerified,
    ...(u.banned ? { ban_duration: "876000h" } : {}),
    user_metadata: userMetadata(u),
    ...(u.metadata?.app ? { app_metadata: u.metadata.app } : {}),
  });
  // supabase-js returns errors rather than throwing, so surface them to the pool.
  if (error) throw error;
  ids.set(u, data.user.id);
}

// Created after the admin-API users on purpose: the CLI orders by created_at,
// so an SSO user sharing an email lands second, which is the realistic order.
const viaSql = users.filter((u) => u.anonymous || u.sso);
const viaApi = users.filter((u) => !u.anonymous && !u.sso);

console.log(`Seeding ${users.length} users into Supabase…`);
const failures = await pool(viaApi, 8, createUser, progressBar("created"));
reportFailures(failures);

const idsOf = (pick: (u: SeedUser) => boolean) =>
  [...ids].filter(([u]) => pick(u)).map(([, id]) => lit(id));

const blank = idsOf((u) => !u.hasPassword);
if (blank.length)
  await sql(`update auth.users set encrypted_password = '' where id in (${blank.join(", ")})`);

const oauth = [...ids].filter(([u]) => u.oauth?.length);
if (oauth.length) {
  const values = oauth.map(([u, id]) => {
    // "email" only when the user can actually sign in with one: a password.
    const providers = [...(u.hasPassword ? ["email"] : []), ...u.oauth!];
    return `(${lit(id)}, ${jsonb({ provider: u.oauth![0], providers })})`;
  });
  await sql(`update auth.users as u set raw_app_meta_data = u.raw_app_meta_data || v.meta
             from (values ${values.join(", ")}) as v(id, meta) where u.id = v.id::uuid`);
}

if (viaSql.length) {
  const rows = viaSql.map((u) => {
    const sso = `sso:${randomUUID()}`;
    const app = u.sso ? { provider: sso, providers: [sso] } : {};
    return `('00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
              ${u.anonymous ? "null" : lit(u.email!)}, ${u.anonymous || !u.emailVerified ? "null" : "now()"},
              '', ${u.anonymous ? "true" : "false"}, ${u.sso ? "true" : "false"},
              ${jsonb(app)}, ${jsonb(userMetadata(u))}, now(), now())`;
  });
  await sql(`insert into auth.users
               (instance_id, id, aud, role, email, email_confirmed_at, encrypted_password,
                is_anonymous, is_sso_user, raw_app_meta_data, raw_user_meta_data, created_at, updated_at)
             values ${rows.join(", ")}`);
  console.log(`Inserted ${viaSql.length} anonymous/SSO users by SQL.`);
}

// The real soft delete: Supabase obfuscates the identifiers and sets deleted_at.
const deleted = [...ids].filter(([u]) => u.deleted);
for (const [, id] of deleted) {
  const { error } = await supabase.auth.admin.deleteUser(id, true);
  if (error) throw error;
}
if (deleted.length) console.log(`Soft-deleted ${deleted.length} users.`);

const [{ n }] = await sql<{ n: number }>("select count(*)::int as n from auth.users");
console.log(`\nDone. auth.users holds ${n} rows.`);
console.log(`Seed password: ${seedPassword}`);
