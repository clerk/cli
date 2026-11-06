/**
 * Auth.js variations (J1–J7 in .testing-plan.md).
 *
 * Auth.js's config is its adapter schema, and the CLI's exporter reads only
 * `id, name, email, emailVerified` from a table called User, user or users.
 * So each variation recreates the app's own drizzle schema — renamed or
 * snake_cased for J5/J6 — and varies the rows. afterAll restores the app's
 * schema and its 500 seed users.
 */
import { createClient } from "@libsql/client";
import { authjsStatements, clearRows, tableNames } from "../lib/better-auth-schema";
import { run } from "../lib/run";
import type { SeedUser } from "../lib/users";
import { everyNth, expectLanded, reserving, type Variation } from "../lib/variations";

/** A fresh client per step (see better-auth.ts: long idles kill pooled sockets). */
const db = () =>
  createClient({
    url: process.env.AUTHJS_TURSO_DATABASE_URL!,
    authToken: process.env.AUTHJS_TURSO_DATABASE_TOKEN!,
  });

const BASE_DDL = authjsStatements();

/** Drops every table, then applies the app schema with `edit` applied to each statement. */
const schema =
  (edit: (sql: string) => string = (sql) => sql) =>
  async () => {
    const client = db();
    const tables = await tableNames(client);
    for (const t of [
      ...tables.filter((t) => t !== "user" && t !== "users"),
      ...tables.filter((t) => t === "user" || t === "users"),
    ])
      await client.execute(`drop table if exists "${t}"`);
    for (const sql of BASE_DDL) await client.execute(edit(sql));
  };

export const reset = () => clearRows(db());

export async function afterAll() {
  await schema()();
  const { code, stderr } = await run("bun", ["seed.ts", "-p", "authjs", "-r"]);
  if (code !== 0) throw new Error(`reseeding the app's 500 users failed: ${stderr.slice(-300)}`);
}

const withEmail = (all: SeedUser[]) => all.filter((u) => u.email);
/** Auth.js carries no password, and the CLI reads no username or phone column. */
const authjs = { withPassword: 0, withUsername: 0, withPhone: 0 };
const allVerified = {
  withVerifiedEmail: (seeded: SeedUser[]) => seeded.filter((u) => u.email || u.phone).length,
};

export const variations: Variation[] = [
  {
    id: "J1",
    describe: "magic link only: every user verified by timestamp",
    sourceConfig: schema(),
    users: (all) =>
      withEmail(all)
        .slice(0, 40)
        .map((u) => ({ ...u, emailVerified: true })),
    expect: expectLanded({ ...authjs, ...allVerified }),
  },
  {
    id: "J2",
    describe: "GitHub only: unverified emails, and 1 in 4 shared no email at all",
    sourceConfig: schema(),
    users: (all) =>
      withEmail(all)
        .slice(0, 40)
        .map((u, i) => ({
          ...u,
          oauth: ["github"],
          emailVerified: false,
          ...(i % 4 === 0 && { email: null, phone: null }),
        })),
    // No email and no phone is no identifier at all: those are rejected.
    expect: expectLanded({
      ...authjs,
      total: (seeded) => seeded.filter((u) => u.email).length,
      withVerifiedEmail: 0,
    }),
  },
  {
    id: "J3",
    describe: "email + GitHub: account rows are ignored, so this exports like J1",
    sourceConfig: schema(),
    users: (all) =>
      withEmail(all)
        .slice(0, 40)
        .map((u, i) => ({ ...u, emailVerified: true, ...(i % 2 === 0 && { oauth: ["github"] }) })),
    expect: expectLanded({ ...authjs, ...allVerified }),
  },
  {
    id: "J4",
    describe:
      "phone OTP: verified <digits>@phone.local placeholders, which Clerk refuses (cli-bugs #10)",
    sourceConfig: schema(),
    users: (all) =>
      [
        ...all.filter((u) => u.group === "phone-only").slice(0, 20),
        ...all.filter((u) => u.group === "both").slice(0, 10),
      ]
        // The app's phone-otp provider sets emailVerified when the code is redeemed.
        .map((u) => ({ ...u, emailVerified: true })),
    // Only id/name/email/emailVerified are read; the phone column is this app's
    // own, not Auth.js's. A phone-only user's sole email is the @phone.local
    // placeholder Clerk refuses, so the CLI drops it and rejects the user in
    // the dry run (cli-bugs #10, a33767f6). Only users with a real email land.
    expect: expectLanded({
      ...authjs,
      total: (seeded) => seeded.filter((u) => u.email).length,
      withVerifiedEmail: (seeded) => seeded.filter((u) => u.email).length,
    }),
  },
  {
    id: "J5",
    describe: "user table renamed to `users`: the exporter's fallback table name",
    sourceConfig: schema((sql) => sql.replaceAll("`user`", "`users`")),
    users: everyNth(10),
    // Phone-only users have only the @phone.local placeholder (their phone is in
    // this app's own column, which Auth.js doesn't define): rejected, see J4.
    expect: expectLanded({ ...authjs, total: (seeded) => seeded.filter((u) => u.email).length }),
  },
  {
    id: "J6",
    describe:
      "snake_case `email_verified` column (a Prisma @map, or legacy NextAuth): the exporter falls back to it",
    sourceConfig: schema((sql) => sql.replaceAll("`emailVerified`", "`email_verified`")),
    // Half verified, half not: a misread column would make every user verified
    // (SQLite reads a missing quoted column as a string literal) or none.
    users: (all) =>
      withEmail(all)
        .slice(0, 40)
        .map((u, i) => ({ ...u, emailVerified: i % 2 === 0 })),
    expect: expectLanded({
      ...authjs,
      withVerifiedEmail: (seeded) => seeded.filter((u) => u.emailVerified).length,
    }),
  },
  {
    id: "J7",
    describe: "names: one word, two words, three words",
    sourceConfig: schema(),
    users: (all) =>
      withEmail(all)
        .slice(0, NAMES.length)
        .map((u, i) => ({
          ...u,
          emailVerified: true,
          fullName: NAMES[i],
          firstName: null,
          lastName: null,
        })),
    expect: (clerk, seeded, dest, users) => {
      const issues = expectLanded({ ...authjs, ...allVerified })(clerk, seeded, dest);
      for (const name of NAMES) {
        const [first, ...rest] = name.split(" ");
        const u = users.find((x) =>
          x.emailAddresses.some(
            (e) => seeded.find((s) => s.fullName === name)?.email === e.emailAddress,
          ),
        );
        const want = { firstName: first, lastName: rest.join(" ") || null };
        if (!u) issues.push(`"${name}": user not found`);
        else if (u.firstName !== want.firstName || (u.lastName || null) !== want.lastName)
          issues.push(
            `"${name}" → first ${JSON.stringify(u.firstName)}, last ${JSON.stringify(u.lastName)}`,
          );
      }
      return issues;
    },
  },
];
variations.push(reserving(variations.find((v) => v.id === "J2")!));

const NAMES = [
  "Cher",
  "Prince",
  "Zendaya",
  "Ada Lovelace",
  "Jean-Luc Picard",
  "Mary Ann Evans",
  "Gabriel García Márquez",
];
