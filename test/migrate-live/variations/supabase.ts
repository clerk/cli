/**
 * Supabase variations (S1–S8 in .testing-plan.md).
 *
 * Seeding doesn't depend on the project's auth config: the admin API and SQL
 * write rows whatever is enabled, and the CLI reads `auth.users` directly. So
 * these vary the rows, not the config. seed-supabase.ts makes the shapes the
 * admin API can't (passwordless, OAuth providers, anonymous, SSO).
 *
 * What the CLI carries (export/supabase.ts, sources/supabase.ts @ 6630765a):
 * email + email_confirmed_at, bcrypt encrypted_password, phone (+ added back),
 * first/last name from user metadata, raw_user_meta_data → unsafe metadata,
 * banned_until in the future → banned. Not carried: usernames (Supabase has
 * none — they live in user metadata), raw_app_meta_data, MFA.
 */
import { sql } from "../lib/supabase";
import { run } from "../lib/run";
import type { SeedUser } from "../lib/users";
import { everyNth, expectLanded, mix, type Variation } from "../lib/variations";

/** One statement; cascades to identities, sessions and factors. */
export const reset = async () => void (await sql("delete from auth.users"));

export async function afterAll() {
  await reset();
  const { code, stderr } = await run("bun", ["seed.ts", "-p", "supabase"]);
  if (code !== 0) throw new Error(`reseeding the app's 500 users failed: ${stderr.slice(-300)}`);
}

const withEmail = (all: SeedUser[]) => all.filter((u) => u.email);
const emailOnly = (all: SeedUser[]) => all.filter((u) => u.group === "email-only");
/** Supabase has no username identifier; the seed's usernames ride in user metadata. */
const supabase = { withUsername: 0 };

const DISCORD_NAME = "Discordian#0";
const HEAVY = {
  user: {
    preferences: { theme: "dark", locale: "fr-CA", notifications: { email: true, sms: false } },
    tags: ["beta", "early-adopter", "migrated"],
    bio: "x".repeat(2000),
  },
  app: { plan: "enterprise", roles: ["admin", "billing"] },
};

export const variations: Variation[] = [
  {
    id: "S1",
    describe: "email + password (gotrue bcrypt)",
    users: (all) => emailOnly(all).slice(0, 30),
    expect: expectLanded(supabase),
  },
  {
    id: "S2",
    describe: "passwordless (magic link / email OTP): encrypted_password = ''",
    users: (all) =>
      emailOnly(all)
        .slice(0, 20)
        .map((u) => ({ ...u, hasPassword: false })),
    // '' must read as "no password", not as a malformed bcrypt hash.
    expect: expectLanded(supabase),
  },
  {
    id: "S3",
    describe: "phone only, stored without the + (cli-bugs plan #5, fixed 0effeda3)",
    users: mix({ "phone-only": 20 }),
    expect: expectLanded(supabase),
  },
  {
    id: "S4",
    describe: "email + password + phone",
    users: mix({ both: 20 }),
    expect: expectLanded(supabase),
  },
  {
    id: "S5",
    describe: "unconfirmed: half the emails, a third of the phones",
    users: (all) =>
      mix({ "email-only": 10, both: 10 })(all).map((u, i) => ({
        ...u,
        ...(i % 2 === 0 && { emailVerified: false }),
        ...(u.phone && i % 3 === 0 && { phoneVerified: false }),
      })),
    expect: expectLanded({
      ...supabase,
      withVerifiedEmail: (seeded) => seeded.filter((u) => u.email && u.emailVerified).length,
    }),
  },
  {
    id: "S6",
    describe:
      "OAuth: GitHub only, Google only, and password + GitHub (Clerk dev: Google on, GitHub off)",
    users: (all) =>
      emailOnly(all)
        .slice(0, 30)
        .map(
          (u, i) =>
            [
              { ...u, hasPassword: false, oauth: ["github"] },
              { ...u, hasPassword: false, oauth: ["google"] },
              { ...u, oauth: ["github"] },
            ][i % 3],
        ),
    // Everyone lands: GitHub is off in Clerk, but a GitHub-only user's email
    // still signs in by code on D1, so the CLI warns instead of rejecting.
    expect: expectLanded(supabase),
  },
  {
    id: "S7",
    describe:
      "edge cases: banned, soft-deleted, argon2id, heavy metadata, anonymous, SSO duplicate email",
    users: (all) => {
      const base = withEmail(all)
        .slice(0, 15)
        .map((u, i) => {
          switch (i % 5) {
            case 0:
              return { ...u, banned: true };
            case 1:
              return { ...u, deleted: true };
            case 2:
              return { ...u, hasPassword: true, passwordFormat: "argon2id" as const };
            case 3:
              // The Discord user has only a display name, as a Discord sign-up
              // does: a metadata first_name would outrank it.
              return i === 3
                ? {
                    ...u,
                    firstName: null,
                    lastName: null,
                    fullName: null,
                    metadata: { ...HEAVY, user: { ...HEAVY.user, display_name: DISCORD_NAME } },
                  }
                : { ...u, metadata: HEAVY };
            default:
              return u;
          }
        });
      const anonymous = base.slice(0, 3).map((u) => ({
        ...u,
        id: `anon-${u.id}`,
        anonymous: true,
        email: null,
        phone: null,
        hasPassword: false,
        banned: false,
        deleted: false,
        passwordFormat: undefined,
        metadata: undefined,
      }));
      // An SSO user may share a regular user's email in Supabase (is_sso_user).
      const sso = base
        .filter((_, i) => i % 5 === 4)
        .slice(0, 2)
        .map((u) => ({
          ...u,
          id: `sso-${u.id}`,
          sso: true,
          phone: null,
          hasPassword: false,
        }));
      return [...base, ...anonymous, ...sso];
    },
    expect: (clerk, seeded, dest, users) => {
      if (dest !== "D1") return [];
      // Want: guests, soft-deleted accounts and the SSO twin don't migrate.
      const real = seeded.filter((u) => !u.anonymous && !u.sso && !u.deleted);
      const issues = expectLanded({
        ...supabase,
        total: real.length,
        withPassword: real.filter((u) => u.hasPassword).length,
        withPhone: real.filter((u) => u.phone).length,
      })(clerk, real, dest);
      const heavy = real.filter((u) => u.metadata).length;
      const carried = users.filter((u) => (u.unsafeMetadata as { tags?: unknown }).tags).length;
      if (carried !== heavy) issues.push(`user metadata → unsafe metadata: ${carried} of ${heavy}`);
      // Documented: raw_app_meta_data is not carried.
      if (users.some((u) => (u.privateMetadata as { plan?: unknown }).plan))
        issues.push("app metadata came across, which the source says it doesn't carry");
      if (!users.some((u) => u.firstName === "Discordian"))
        issues.push(`Discord name "${DISCORD_NAME}" did not land as first name "Discordian"`);
      return issues;
    },
  },
  {
    id: "S8",
    describe: "combined: unconfirmed, banned, password + GitHub, passwordless — against D1–D5",
    dests: ["D1", "D2", "D3", "D4", "D5"],
    users: (all) =>
      everyNth(10)(all).map((u, i) => ({
        ...u,
        ...(i % 6 === 0 && { emailVerified: false }),
        ...(i % 6 === 1 && { banned: true }),
        ...(u.email && u.hasPassword && i % 6 === 2 && { oauth: ["github"] }),
        ...(u.email && i % 6 === 3 && { hasPassword: false }),
      })),
    expect: expectLanded(supabase),
  },
];
