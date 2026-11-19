/**
 * Better Auth variations (B1–B10 + the 10K run in .testing-plan.md).
 *
 * Better Auth's "config" is its plugin set, and the plugin set is the schema.
 * So each variation's sourceConfig drops every table and creates the schema for
 * its plugins; the seeder writes only the columns that schema has. afterAll
 * puts back the app's own schema (username + phone) and its 500 seed users.
 */
import { createClient } from "@libsql/client";
import {
  APP_PLUGINS,
  clearRows,
  recreateSchema,
  type SchemaOptions,
} from "../lib/better-auth-schema";
import { run } from "../lib/run";
import type { SeedUser } from "../lib/users";
import type { DestId } from "../lib/clerk-dest";
import {
  everyNth,
  expectAllLanded,
  expectLanded,
  expectRejected,
  reserving,
  type Variation,
} from "../lib/variations";

/**
 * A fresh client per step. One long-lived client sits idle through the seed and
 * export (child processes), and on the 10K run that idle outlasts Turso's
 * keep-alive: the next call lands on a closed socket ("fetch failed", cause
 * "other side closed").
 */
const db = () =>
  createClient({
    url: process.env.BA_TURSO_DATABASE_URL!,
    authToken: process.env.BA_TURSO_DATABASE_TOKEN!,
  });

const schema = (options: SchemaOptions) => () => recreateSchema(db(), options);
const APP_SCHEMA = schema({ plugins: APP_PLUGINS });

export const reset = () => clearRows(db());

export async function afterAll() {
  await recreateSchema(db(), { plugins: APP_PLUGINS });
  const { code, stderr } = await run("bun", ["seed.ts", "-p", "better-auth", "-r"]);
  if (code !== 0) throw new Error(`reseeding the app's 500 users failed: ${stderr.slice(-300)}`);
}

const withEmail = (all: SeedUser[]) => all.filter((u) => u.email);
/**
 * Neither identifier exists without its plugin. Without the phone plugin a
 * phone-only user's only identifier is the @phone.local placeholder Clerk
 * refuses, so the CLI rejects them in the dry run (cli-bugs #10, a33767f6).
 */
const withRealEmail = (seeded: SeedUser[]) => seeded.filter((u) => u.email).length;
const core = {
  withUsername: 0,
  withPhone: 0,
  total: withRealEmail,
  // Banned phone-only users are among those rejected.
  banned: (seeded: SeedUser[]) => seeded.filter((u) => u.banned && u.email).length,
};

export const variations: Variation[] = [
  {
    id: "B0",
    describe: "smoke: the app's own schema (username + phone plugins), 100 users",
    sourceConfig: APP_SCHEMA,
    users: everyNth(5),
    expect: expectAllLanded,
  },
  {
    id: "BP",
    describe: "phone countries: every non-+1 phone in users.json (20 users, 8 countries)",
    sourceConfig: APP_SCHEMA,
    users: (all) => all.filter((u) => u.phone && !u.phone.startsWith("+1")),
    expect: expectAllLanded,
  },
  {
    id: "BI",
    describe: "invalid phones on users that also have an email (cli-bugs #2, fixed 069a1db3)",
    sourceConfig: APP_SCHEMA,
    // Numbers Clerk rejects: Ofcom's drama range, and an unassigned French range.
    users: (all) =>
      all
        .filter((u) => u.group === "both")
        .slice(0, 4)
        .map((u, i) => ({
          ...u,
          phone: ["+447700900293", "+447700900294", "+33690245846", "+33690245847"][i],
        })),
    // Every user is still created from its email; the phone Clerk refuses is dropped.
    expect: expectLanded({ withPhone: 0 }),
  },
  {
    id: "B1",
    describe: "core only: email + password, no plugin columns",
    sourceConfig: schema({}),
    users: everyNth(5),
    expect: expectLanded(core),
  },
  {
    id: "B2",
    describe: "+ username plugin",
    sourceConfig: schema({ plugins: ["username"] }),
    users: everyNth(5),
    // A phone-only user with a username still has an identifier, so it lands.
    expect: expectLanded({
      withPhone: 0,
      total: (seeded) => seeded.filter((u) => u.email || u.username).length,
    }),
  },
  {
    id: "B3",
    describe: "+ phone plugin: verified, unverified and no phone",
    sourceConfig: schema({ plugins: ["phoneNumber"] }),
    users: (all) =>
      everyNth(5)(all).map((u, i) => (u.phone && i % 3 === 0 ? { ...u, phoneVerified: false } : u)),
    expect: expectLanded({ withUsername: 0 }),
  },
  {
    id: "B4",
    describe: "+ admin plugin: 1 in 5 banned (plan bug #1, fixed in ea8fc9dd)",
    sourceConfig: schema({ plugins: ["admin"] }),
    users: (all) => everyNth(5)(all).map((u, i) => (i % 5 === 0 ? { ...u, banned: true } : u)),
    expect: expectLanded(core),
  },
  {
    id: "B5",
    describe: "+ 2FA plugin: 1 in 3 email users enrolled (MFA is documented as not carried)",
    sourceConfig: schema({ plugins: ["twoFactor"] }),
    users: (all) =>
      everyNth(5)(all).map((u, i) => (u.email && i % 3 === 0 ? { ...u, mfa: true } : u)),
    expect: (clerk, seeded, dest, users) => [
      ...expectLanded(core)(clerk, seeded, dest),
      ...(users.some((u) => u.totpEnabled)
        ? ["a TOTP enrolment came across, which the source says it can't"]
        : []),
    ],
  },
  {
    id: "B6",
    describe: "GitHub: social-only (no credential) and password + GitHub",
    sourceConfig: schema({}),
    users: (all) =>
      withEmail(all)
        .slice(0, 40)
        .map((u, i) =>
          i % 2 === 0
            ? { ...u, hasPassword: false, oauth: ["github"] }
            : { ...u, oauth: ["github"] },
        ),
    expect: expectLanded(core),
  },
  {
    id: "B7",
    describe: "password formats: native scrypt, bcrypt, argon2id, and one no hasher accepts",
    sourceConfig: schema({}),
    users: (all) =>
      withEmail(all)
        .slice(0, 40)
        .map((u, i) => ({
          ...u,
          passwordFormat: ([undefined, "bcrypt", "argon2id", "unknown"] as const)[i % 4],
        })),
    // The unknown format should be dropped, not imported as a broken password.
    expect: expectLanded({
      ...core,
      withPassword: (seeded) =>
        seeded.filter((u) => u.hasPassword && u.passwordFormat !== "unknown").length,
    }),
  },
  {
    id: "B8",
    describe: "anonymous plugin: half the users are guests, which the CLI skips (cli-bugs #5)",
    sourceConfig: schema({ plugins: ["anonymous"] }),
    users: (all) =>
      everyNth(10)(all).map((u, i) =>
        i % 2 === 0 ? { ...u, anonymous: true, hasPassword: false } : u,
      ),
    // Guests are throwaway accounts: only the real users should land.
    expect: expectLanded({
      ...core,
      total: (seeded) => seeded.filter((u) => !u.anonymous && u.email).length,
      withPassword: (seeded) => seeded.filter((u) => !u.anonymous && u.hasPassword).length,
    }),
  },
  {
    id: "B9",
    describe: "every plugin at once, mixed cohorts",
    dests: ["D1", "D2", "D3", "D4", "D5"],
    sourceConfig: schema({ plugins: ["username", "phoneNumber", "admin", "twoFactor"] }),
    users: (all) =>
      everyNth(5)(all).map((u, i) => ({
        ...u,
        ...(i % 7 === 0 && { banned: true }),
        ...(u.email && i % 5 === 1 && { mfa: true }),
        ...(u.email && i % 6 === 2 && { oauth: ["github"] }),
        ...(u.hasPassword && i % 9 === 3 && { passwordFormat: "bcrypt" as const }),
      })),
    expect: expectAllLanded,
    // Exactly the users each dest must refuse, and for what (not just "the
    // dry run agreed with the import").
    expectChecks: (_checks, rejected, _seeded, dest, exported) =>
      expectRejected(
        rejected,
        exported,
        (r) => String(r.user_id),
        (r) => B9_REJECTS[dest](r),
      ),
  },
  {
    id: "B10",
    describe: "user table renamed to `users` (modelName): the exporter should refuse clearly",
    sourceConfig: schema({ userTable: "users" }),
    users: everyNth(10),
    expectExportFailure: true,
  },
  // ── Deliberate failures: what the CLI must refuse, warn about, or leave alone ──
  {
    id: "X1",
    describe: "password required (D2), half the users have none: imported anyway, with a warning",
    dests: ["D2"],
    sourceConfig: APP_SCHEMA,
    users: (all) =>
      plain(all)
        .slice(0, 20)
        .map((u, i) => ({ ...u, hasPassword: i % 2 === 0 })),
    // The CLI creates them with skip_password_requirement; they reset it to sign in.
    expectChecks: (checks) => [
      ...(checks.rejects.length ? [`${checks.rejects.length} rejected, expected none`] : []),
      ...(checks.warnings.some((w) => /without a password, which this instance requires/.test(w))
        ? []
        : ['no "without a password, which this instance requires" warning']),
    ],
    expect: (clerk, seeded) =>
      counts(clerk, {
        total: seeded.length,
        withPassword: seeded.filter((u) => u.hasPassword).length,
      }),
  },
  {
    id: "X2",
    describe: "--require-password: users without one are left out",
    sourceConfig: APP_SCHEMA,
    importArgs: ["--require-password"],
    users: (all) =>
      plain(all)
        .slice(0, 20)
        .map((u, i) => ({ ...u, hasPassword: i % 2 === 0 })),
    expect: (clerk, seeded) => {
      const n = seeded.filter((u) => u.hasPassword).length;
      return counts(clerk, { total: n, withPassword: n });
    },
  },
  {
    id: "X3",
    describe: "already in Clerk: an email, a phone and a username taken by existing users",
    sourceConfig: APP_SCHEMA,
    users: (all) => [...collidable(all).slice(0, 3), ...plain(all).slice(0, 3)],
    beforeImport: async (clerk, seeded) => {
      const [a, b, c] = seeded;
      const made = [
        await clerk.users.createUser({ emailAddress: [a.email!], skipPasswordRequirement: true }),
        await clerk.users.createUser({
          phoneNumber: [b.phone!],
          emailAddress: ["x3-phone+clerk_test@example.com"],
          skipPasswordRequirement: true,
        }),
        await clerk.users.createUser({
          username: c.username!,
          emailAddress: ["x3-username+clerk_test@example.com"],
          skipPasswordRequirement: true,
        }),
      ];
      return made.map((u) => u.id);
    },
    expectChecks: (_checks, rejected, seeded, _dest, exported) => {
      const [a, b, c] = seeded;
      return expectRejected(
        rejected,
        exported,
        (r) => String(r.user_id),
        (r) =>
          r.email === a.email
            ? /email is already used/
            : r.phone_number === b.phone
              ? /phone number is already used/
              : r.username === c.username
                ? /username is already taken/
                : null,
      );
    },
    expect: (clerk, seeded) => counts(clerk, { total: seeded.length - 3 }),
  },
  {
    id: "X4",
    describe: "over the dev instance's 100-user limit: 1 user already there, 100 to import",
    sourceConfig: APP_SCHEMA,
    users: everyNth(5),
    beforeImport: async (clerk) => [
      (
        await clerk.users.createUser({
          emailAddress: ["x4-existing+clerk_test@example.com"],
          skipPasswordRequirement: true,
        })
      ).id,
    ],
    expectChecks: (checks) => {
      const limit = checks.rejects.filter((r) => /100-user limit/.test(r.reason)).length;
      return limit === 1 && checks.rejects.length === 1
        ? []
        : [
            `expected exactly 1 reject for the 100-user limit, got ${limit} of ${checks.rejects.length}`,
          ];
    },
    expect: (clerk, seeded) => counts(clerk, { total: seeded.length - 1 }),
  },
  {
    id: "X5",
    describe: 're-run a completed import: "already imported", nothing added',
    sourceConfig: APP_SCHEMA,
    users: (all) => plain(all).slice(0, 10),
    reimport: true,
    expect: (clerk, seeded) => counts(clerk, { total: seeded.length }),
  },
  {
    id: "BK1K",
    describe: "1K on the raised-limit dev instance: a 10% slice of data/users-10k.json",
    targets: ["10k-dev"],
    usersFile: "data/users-10k.json",
    sourceConfig: APP_SCHEMA,
    // One user per block of 10, at a rotating offset. Plain every-10th fails:
    // the generator hands out usernames and names on a 10-user cycle, so every
    // 10th user has all of them or none. This lands on exactly 10% of every
    // ratio — 600/150/250 groups, 300 usernames, 300 names, 850 passwords.
    users: (all) => all.filter((_, i) => i % 10 === Math.floor(i / 10) % 10),
    expect: expectAllLanded,
  },
  {
    id: "BK",
    describe: "10K on production: data/users-10k.json, the app's schema — rate-limit throttling",
    targets: ["10k-prod"],
    usersFile: "data/users-10k.json",
    sourceConfig: APP_SCHEMA,
    users: (all) => all,
    expect: expectAllLanded,
  },
];
variations.push(reserving(variations.find((v) => v.id === "B3")!));

/** Verified email, no username: users nothing else would reject. */
const plain = (all: SeedUser[]) => all.filter((u) => u.email && u.emailVerified && !u.username);
/** Email + phone + a username Clerk's default rules accept: one collision of each kind. */
const collidable = (all: SeedUser[]) =>
  all.filter((u) => u.group === "both" && u.username && /^[a-z0-9_-]{4,}$/i.test(u.username));

const counts = (
  clerk: { total: number; withPassword: number },
  want: Partial<{ total: number; withPassword: number }>,
) =>
  Object.entries(want)
    .filter(([k, v]) => clerk[k as keyof typeof want] !== v)
    .map(([k, v]) => `${k}: expected ${v}, got ${clerk[k as keyof typeof want]}`);

type Row = Record<string, unknown>;
const REFUSED_TLD = /\.(local|invalid|test|example|arpa)$/i;
const verifiedEmail = (r: Row) =>
  !!r.email && Number(r.email_verified) === 1 && !REFUSED_TLD.test(String(r.email));
const verifiedPhone = (r: Row) => !!r.phone_number && Number(r.phone_number_verified) === 1;
/** Clerk's default username rules: letters, digits, - and _, at least 4. */
const badUsername = (r: Row) =>
  typeof r.username === "string" && !/^[a-z0-9_-]{4,}$/i.test(r.username);
const anyOf = (...why: (string | false)[]) => {
  const words = why.filter(Boolean) as string[];
  return words.length ? new RegExp(words.join("|")) : null;
};

/**
 * Who each dest must reject in B9, and the word its reason must contain. D1
 * allows everything (extended username characters on); D2–D4 keep Clerk's
 * default username rules; D5 turns phone and username off (dropped, not
 * rejected).
 */
const B9_REJECTS: Record<DestId, (r: Row) => RegExp | null> = {
  D1: () => null,
  D2: (r) => anyOf(!verifiedEmail(r) && "email", badUsername(r) && "username"),
  D3: (r) => anyOf(!verifiedPhone(r) && "phone", badUsername(r) && "username"),
  D4: (r) => anyOf((!r.username || badUsername(r)) && "username"),
  D5: (r) => anyOf(!verifiedEmail(r) && "email"),
};
