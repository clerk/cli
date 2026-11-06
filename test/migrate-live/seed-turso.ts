/**
 * Seeds both Turso databases from the seed file, each with default, unprefixed
 * table names:
 *   migration-test-ba      Better Auth — with genuine scrypt password hashes
 *   migration-test-authjs  Auth.js     — no passwords (Auth.js has no password provider here)
 *
 * A database with no tables yet (newly created) gets its schema first:
 * Better Auth's from its plugins, Auth.js's from schema/authjs.sql.
 *
 * Row shapes were taken from a real Better Auth sign-up, not from docs:
 * dates are ISO-8601 strings, booleans are 0/1 integers, and a credential
 * account carries `password` as "salt:hash" plus issuer "local:credential".
 *
 * Seeds both databases by default. `--provider authjs` or `--provider
 * better-auth` narrows it to one — they are separate databases, so one can be
 * reseeded without touching the other.
 *
 * Run: bun seed-turso.ts [--reset] [--10k] [--provider authjs|better-auth]
 *      (normally reached through `bun seed.ts`)
 */
import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { createClient, type InStatement } from "@libsql/client";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { loadUsers, type SeedUser } from "./lib/users";
import { selectProviders } from "./lib/providers";
import { flag } from "./lib/args";
import {
  APP_PLUGINS,
  authjsStatements,
  recreateSchema,
  tableNames,
} from "./lib/better-auth-schema";

const { seedPassword, users } = loadUsers();

const ba = createClient({
  url: process.env.BA_TURSO_DATABASE_URL!,
  authToken: process.env.BA_TURSO_DATABASE_TOKEN!,
});
const na = createClient({
  url: process.env.AUTHJS_TURSO_DATABASE_URL!,
  authToken: process.env.AUTHJS_TURSO_DATABASE_TOKEN!,
});

const id = () => randomBytes(16).toString("hex");
/** Better Auth requires a non-null unique email, so phone-only users get one. */
const placeholderEmail = (phone: string) => `${phone.replace(/\D/g, "")}@phone.local`;
const displayName = (u: SeedUser) =>
  u.fullName ?? u.username ?? u.email?.split("@")[0] ?? u.phone ?? "User";

/**
 * These tables are always cleared before inserting; --reset is what allows that
 * to happen over rows that already exist. Without it the seeder refuses rather
 * than quietly dropping someone's sessions and linked OAuth accounts.
 */
const reset = flag("reset");

const selected = new Set(selectProviders("seed"));
const doBa = selected.has("better-auth");
const doNa = selected.has("authjs");

if (doBa && !(await tableNames(ba)).length) await recreateSchema(ba, { plugins: APP_PLUGINS });
if (doNa && !(await tableNames(na)).length)
  for (const sql of authjsStatements()) await na.execute(sql);

/*
 * Better Auth's schema depends on its plugins (the migration tests recreate it
 * per variation), so read what is actually there: which tables to clear, what
 * the user table is called, and which plugin columns it has.
 */
const baTables = doBa ? await tableNames(ba) : [];
const BA_USER = baTables.includes("users") && !baTables.includes("user") ? "users" : "user";
const baColumns = doBa
  ? new Set((await ba.execute(`pragma table_info("${BA_USER}")`)).rows.map((r) => String(r.name)))
  : new Set<string>();
const has = (column: string) => baColumns.has(column);
const userFirstLast = (tables: string[]) => [
  ...tables.filter((t) => t !== BA_USER),
  ...tables.filter((t) => t === BA_USER),
];

/*
 * Auth.js likewise: the migration tests vary its schema (the user table
 * renamed, a snake_case verified column), so read those off the database too.
 */
const naTables = doNa ? await tableNames(na) : [];
const NA_USER = naTables.includes("users") && !naTables.includes("user") ? "users" : "user";
const naColumns = doNa
  ? new Set((await na.execute(`pragma table_info("${NA_USER}")`)).rows.map((r) => String(r.name)))
  : new Set<string>();
const NA_VERIFIED = naColumns.has("email_verified") ? "email_verified" : "emailVerified";

// Children first — foreign keys cascade, but explicit order keeps this readable.
const ALL_TABLES = [
  ["better-auth", ba, userFirstLast(baTables)],
  [
    "authjs",
    na,
    [...naTables.filter((t) => t !== NA_USER), ...naTables.filter((t) => t === NA_USER)],
  ],
] as const;
const TABLES = ALL_TABLES.filter(([name]) => (name === "better-auth" ? doBa : doNa));

for (const [name, client, tables] of TABLES)
  for (const table of tables) {
    const { rows } = await client.execute(`select count(*) as n from "${table}"`);
    const n = Number(rows[0].n);
    // Throw rather than exit: `bun seed.ts` runs several seeders in one process,
    // and this guard must not take the others down with it.
    if (n > 0 && !reset)
      throw new Error(
        `refusing to seed ${name}: ${table} already has ${n} rows. ` +
          `Re-run with --reset (-r) to clear ${tables.join(", ")} first.`,
      );
  }

for (const [, client, tables] of TABLES)
  for (const table of tables) await client.execute(`delete from "${table}"`);

// One hash for the shared seed password. Hashing 425 times would cost minutes
// of scrypt for no benefit: every user has the same password by design.
const sharedHash = await hashPassword(seedPassword);
assert.ok(await verifyPassword({ password: seedPassword, hash: sharedHash }));

/**
 * Other formats a Better Auth database can hold — imported from an older
 * system, or a custom `password.hash`. The argon2id one is a fixed hash of the
 * seed password (m=19456,t=2,p=1), so it verifies in Clerk. `unknown` is a shape
 * no hasher accepts, which the CLI should drop rather than import.
 */
const HASHES = {
  bcrypt: await bcrypt.hash(seedPassword, 10),
  argon2id:
    "$argon2id$v=19$m=19456,t=2,p=1$bWlncmF0aW9uLXRlc3Qtc2FsdC0xNmI$gBbnEhvXQQCPhOB0CWeS82tBRGEQX2Lxu/aAZhtFEsU",
  unknown: `sha256:${createHash("sha256").update(seedPassword).digest("hex")}`,
};
/** Only the formats a Better Auth database plausibly holds; anything else is a test bug. */
function baHash(format: NonNullable<SeedUser["passwordFormat"]>) {
  if (!(format in HASHES))
    throw new Error(`Better Auth seeding has no "${format}" password format`);
  return HASHES[format as keyof typeof HASHES];
}

const baStatements: InStatement[] = [];
const naStatements: InStatement[] = [];
let withPassword = 0;

for (const u of users) {
  const now = new Date().toISOString();
  // Null only for a J2-style user with neither, which only the Auth.js half seeds.
  const email = u.email ?? (u.phone ? placeholderEmail(u.phone) : null);

  const baUserId = id();
  // Only the columns this schema has: the plugin set decides them.
  const row: Record<string, unknown> = {
    id: baUserId,
    name: displayName(u),
    email: u.anonymous ? `anon-${baUserId}@anonymous.invalid` : email,
    emailVerified: u.emailVerified && !u.anonymous ? 1 : 0,
    image: null,
    createdAt: now,
    updatedAt: now,
    ...(has("phoneNumber") && {
      phoneNumber: u.phone,
      phoneNumberVerified: u.phone ? (u.phoneVerified ? 1 : 0) : null,
    }),
    ...(has("username") && { username: u.username, displayUsername: u.username }),
    ...(has("banned") && {
      role: "user",
      banned: u.banned ? 1 : 0,
      banReason: u.banned ? "seeded ban" : null,
      banExpires: null,
    }),
    ...(has("twoFactorEnabled") && { twoFactorEnabled: u.mfa ? 1 : 0 }),
    ...(has("isAnonymous") && { isAnonymous: u.anonymous ? 1 : 0 }),
  };
  baStatements.push({
    sql: `insert into "${BA_USER}" (${Object.keys(row)
      .map((k) => `"${k}"`)
      .join(", ")})
          values (${Object.keys(row)
            .map(() => "?")
            .join(", ")})`,
    args: Object.values(row) as never[],
  });

  if (u.hasPassword) {
    withPassword++;
    baStatements.push({
      sql: `insert into account
              (id, accountId, providerId, userId, password, issuer, createdAt, updatedAt)
            values (?, ?, 'credential', ?, ?, 'local:credential', ?, ?)`,
      args: [
        id(),
        baUserId,
        baUserId,
        u.passwordFormat ? baHash(u.passwordFormat) : sharedHash,
        now,
        now,
      ],
    });
  }

  for (const provider of u.oauth ?? [])
    baStatements.push({
      sql: `insert into account (id, accountId, providerId, userId, issuer, scope, createdAt, updatedAt)
            values (?, ?, ?, ?, ?, 'read:user,user:email', ?, ?)`,
      args: [
        id(),
        String(10_000_000 + baStatements.length),
        provider,
        baUserId,
        `local:oauth:${provider}`,
        now,
        now,
      ],
    });

  if (u.mfa && baTables.includes("twoFactor"))
    baStatements.push({
      sql: `insert into "twoFactor" (id, secret, backupCodes, userId, verified, failedVerificationCount)
            values (?, ?, ?, ?, 1, 0)`,
      args: [id(), randomBytes(20).toString("hex"), randomBytes(40).toString("hex"), baUserId],
    });

  const naUserId = id();
  const naRow: Record<string, unknown> = {
    id: naUserId,
    name: displayName(u),
    // Auth.js allows a null email. Phone-only users get the same pseudo-address
    // the phone-otp provider normalises to, so they can actually sign in; a user
    // with neither (an OAuth account that shared no email) keeps a null.
    email: u.email ?? (u.phone ? placeholderEmail(u.phone) : null),
    [NA_VERIFIED]: u.emailVerified ? Date.now() : null,
    image: null,
    ...(naColumns.has("phone") && { phone: u.phone }),
  };
  naStatements.push({
    sql: `insert into "${NA_USER}" (${Object.keys(naRow)
      .map((k) => `"${k}"`)
      .join(", ")})
          values (${Object.keys(naRow)
            .map(() => "?")
            .join(", ")})`,
    args: Object.values(naRow) as never[],
  });
  for (const provider of u.oauth ?? [])
    naStatements.push({
      sql: `insert into account (userId, type, provider, providerAccountId, scope)
            values (?, 'oauth', ?, ?, 'read:user,user:email')`,
      args: [naUserId, provider, String(20_000_000 + naStatements.length)],
    });
}

// libSQL caps how much one batch can carry; 200 statements per round trip is
// comfortably under it and keeps the whole seed to a handful of requests.
const BATCHES = (
  [
    [ba, baStatements, "better-auth"],
    [na, naStatements, "authjs"],
  ] as const
).filter(([, , label]) => (label === "better-auth" ? doBa : doNa));

for (const [client, statements, label] of BATCHES) {
  for (let i = 0; i < statements.length; i += 200) {
    await client.batch(statements.slice(i, i + 200));
    process.stdout.write(
      `\r  ${label}: ${Math.min(i + 200, statements.length)}/${statements.length} statements`,
    );
  }
  console.log();
}

await check(withPassword);

async function check(expectedPasswords: number) {
  const count = async (client: typeof ba, t: string) =>
    Number((await client.execute(`select count(*) as n from "${t}"`)).rows[0].n);

  const summary: Record<string, number> = {};

  if (doBa) {
    const credential = Number(
      (await ba.execute("select count(*) as n from account where providerId = 'credential'"))
        .rows[0].n,
    );
    assert.equal(await count(ba, BA_USER), users.length);
    assert.equal(credential, expectedPasswords);

    // The native hash must be readable back out, or every seeded sign-in fails silently.
    const { rows } = await ba.execute(
      "select password from account where providerId = 'credential' and password like '%:%' and password not like 'sha256:%' limit 1",
    );
    if (rows.length)
      assert.ok(
        await verifyPassword({ password: seedPassword, hash: String(rows[0].password) }),
        "stored password hash does not verify against the seed password",
      );

    summary["better-auth user"] = await count(ba, BA_USER);
    summary["better-auth account (password)"] = credential;
    summary["better-auth account (oauth)"] = (await count(ba, "account")) - credential;
    for (const column of ["phoneNumber", "username", "banned", "twoFactorEnabled", "isAnonymous"])
      if (has(column))
        summary[`better-auth user with ${column}`] = Number(
          (
            await ba.execute(
              `select count(*) as n from "${BA_USER}" where "${column}" is not null and "${column}" != 0`,
            )
          ).rows[0].n,
        );
  }

  if (doNa) {
    assert.equal(await count(na, NA_USER), users.length);
    summary["authjs user"] = await count(na, NA_USER);
    summary["authjs account (oauth)"] = await count(na, "account");
  }

  console.table(summary);
  console.log(`Seed password: ${seedPassword}`);
}
