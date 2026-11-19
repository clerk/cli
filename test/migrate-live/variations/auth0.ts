/**
 * Auth0 variations (A1–A7 in .testing-plan.md).
 *
 * The CLI exports the whole tenant, so each variation gets the tenant to
 * itself: a throwaway `mt-…` database connection, created by sourceConfig and
 * deleted by reset (Auth0 deletes a connection's users server-side, which beats
 * one 2-per-second DELETE per user). SMS users get a per-variation `sms`
 * connection the same way. Passwordless email users live in the tenant's
 * existing `email` connection, which is shared and never deleted.
 */
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { api, json, waitForUserCount } from "../lib/auth0";
import { run } from "../lib/run";
import { pool, type SeedUser } from "../lib/users";
import { expectLanded, mix, type Variation } from "../lib/variations";

const PREFIX = "mt-";

/** Auth0 refuses users on a connection no application has enabled. */
async function createConnection(body: { name: string; strategy: string; options: object }) {
  // Deleting a connection is asynchronous, and `sms` must always have that
  // name: re-creating it straight after the last variation's reset returns
  // 409 connection_conflict until the old one is gone.
  let c: { id: string } | undefined;
  for (let attempt = 1; !c; attempt++) {
    try {
      c = await api<{ id: string }>("/connections", json("POST", body));
    } catch (e) {
      if (!String((e as Error).message).includes("connection_conflict") || attempt >= 12) throw e;
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
  await api(
    `/connections/${c.id}/clients`,
    json("PATCH", [{ client_id: process.env.AUTH0_CLIENT_ID, status: true }]),
  );
}

/** Makes a fresh DB connection and points seed-auth0.ts at it. */
const useConnection = (id: string, options: object) => async () => {
  const name = `${PREFIX}${id.toLowerCase()}-${randomBytes(3).toString("hex")}`;
  await createConnection({ name, strategy: "auth0", options });
  // Read by the seeder child process, which inherits this env.
  process.env.AUTH0_DB_CONNECTION = name;
};

/**
 * Passwordless SMS. A tenant holds one `sms` connection, so it is created per
 * variation and deleted by reset. Needs a phone provider on the tenant (the
 * no-op Custom provider is enough: users are created by API, nothing is sent).
 */
const useSms = async () =>
  createConnection({ name: "sms", strategy: "sms", options: { disable_signup: false } });

async function seedSms(users: SeedUser[]) {
  const failures = await pool(users, 2, async (u) => {
    await api(
      "/users",
      json("POST", {
        connection: "sms",
        phone_number: u.phone,
        phone_verified: u.phoneVerified,
        user_metadata: { seed_id: u.id },
      }),
    );
  });
  if (failures.length)
    throw new Error(`${failures.length} SMS users failed: ${String(failures[0].error)}`);
}

/** Passwordless users can't be bulk imported: one POST each, no email sent. */
async function seedPasswordless(users: SeedUser[]) {
  const failures = await pool(users, 2, async (u) => {
    await api(
      "/users",
      json("POST", {
        connection: "email",
        email: u.email,
        email_verified: true,
        verify_email: false,
        ...(u.firstName ? { given_name: u.firstName, family_name: u.lastName } : {}),
        user_metadata: { seed_id: u.id },
      }),
    );
  });
  if (failures.length)
    throw new Error(`${failures.length} passwordless users failed: ${String(failures[0].error)}`);
}

/** The normal bulk-import seeder, for a subset of a variation's users. */
async function seedDatabase(users: SeedUser[], seedPassword: string) {
  const file = join(tmpdir(), `auth0-db-${process.pid}.json`);
  writeFileSync(file, JSON.stringify({ seedPassword, users }));
  const { code, stderr } = await run("bun", ["seed.ts", "-p", "auth0"], {
    ...process.env,
    SEED_USERS_FILE: file,
  });
  if (code !== 0) throw new Error(`Auth0 DB seed failed: ${stderr.slice(-300)}`);
}

export async function reset() {
  // Deleting a connection deletes its users server-side: the test DB
  // connections and the per-variation sms one. `email` predates the tests.
  const connections = await api<{ id: string; name: string }[]>("/connections");
  for (const c of connections.filter((c) => c.name.startsWith(PREFIX) || c.name === "sms"))
    await api(`/connections/${c.id}`, { method: "DELETE" });

  // Passwordless users, and anything else left over, go one by one.
  for (;;) {
    const users = await api<{ user_id: string }[]>(
      "/users?per_page=100&fields=user_id&include_fields=true",
    );
    if (!users.length) break;
    await pool(users, 2, async (u) => {
      await api(`/users/${encodeURIComponent(u.user_id)}`, { method: "DELETE" }).catch((e) => {
        if (e.status !== 404) throw e;
      });
    });
    // A deleted connection's users linger in the index briefly; give it a beat.
    await new Promise((r) => setTimeout(r, 3000));
  }
  await waitForUserCount(0);
}

export async function afterSeed(seeded: SeedUser[]) {
  await waitForUserCount(seeded.length);
}

/** A6: passwordless users that reuse a DB user's email. */
const A6_SHARED = 2;
const shared = (db: SeedUser[]) => db.filter((u) => !u.username && !u.phone).slice(0, A6_SHARED);

/** Flexible Identifiers: email required; phone and username optional, all stored natively. */
const A6_ATTRIBUTES = {
  email: {
    identifier: { active: true },
    signup: { status: "required", verification: { active: false } },
    profile_required: true,
  },
  phone_number: {
    identifier: { active: true },
    signup: { status: "optional", verification: { active: false } },
    profile_required: false,
  },
  username: {
    identifier: { active: true },
    signup: { status: "optional" },
    profile_required: false,
    validation: { min_length: 1, max_length: 30 },
  },
};
const auth0Ids = (prefix: string) => (users: { externalId: string | null }[]) =>
  users.filter((u) => u.externalId?.startsWith(prefix)).length;

/** Auth0 never exports password hashes, so no source carries a password across. */
const noPasswords = { withPassword: 0 };

export const variations: Variation[] = [
  {
    id: "A1",
    describe: "email + password, default DB connection (username/phone in metadata)",
    sourceConfig: useConnection("A1", {}),
    // 12 users: every group, with a username, a full name and a European phone.
    users: mix({ "email-only": 4, "phone-only": 3, both: 5 }),
    // Phone-only users keep their phone in metadata here, so their only
    // identifier is the <digits>@phone.local placeholder Clerk refuses: the CLI
    // drops it and rejects them in the dry run (cli-bugs #10, a33767f6).
    expect: expectLanded({
      ...noPasswords,
      withUsername: 0,
      withPhone: 0,
      total: (seeded) => seeded.filter((u) => u.email).length,
    }),
  },
  {
    id: "A2",
    describe: "DB connection with requires_username: username on the real field",
    sourceConfig: useConnection("A2", {
      requires_username: true,
      validation: { username: { min: 1, max: 30 } },
    }),
    users: (all) => mix({ "email-only": 4, both: 4 })(all.filter((u) => u.username)),
    expect: expectLanded({ ...noPasswords, withPhone: 0 }),
  },
  {
    id: "A3",
    describe: "Flexible Identifiers: phone_number as an identifier on the DB connection",
    sourceConfig: useConnection("A3", {
      attributes: {
        email: {
          identifier: { active: true },
          signup: { status: "required", verification: { active: false } },
          profile_required: true,
        },
        phone_number: {
          identifier: { active: true },
          signup: { status: "optional", verification: { active: false } },
          profile_required: false,
        },
      },
    }),
    users: mix({ both: 8 }),
    expect: expectLanded({ ...noPasswords, withUsername: 0 }),
  },
  {
    id: "A4",
    describe: "passwordless email only (email| users)",
    users: (all) =>
      mix({ "email-only": 3, both: 3 })(all).map((u) => ({ ...u, hasPassword: false })),
    seed: seedPasswordless,
    expect: (clerk, seeded, dest, users) => [
      ...expectLanded({ withUsername: 0, withPhone: 0 })(clerk, seeded, dest),
      ...(auth0Ids("email|")(users) === seeded.length
        ? []
        : [`expected ${seeded.length} email| external IDs`]),
    ],
  },
  {
    id: "A5",
    describe: "passwordless SMS only (sms| users, phone-only)",
    sourceConfig: useSms,
    users: mix({ "phone-only": 6 }),
    seed: seedSms,
    expect: (clerk, seeded, dest, users) => [
      ...expectLanded({ withUsername: 0 })(clerk, seeded, dest),
      ...(auth0Ids("sms|")(users) === seeded.length
        ? []
        : [`expected ${seeded.length} sms| external IDs`]),
    ],
  },
  {
    id: "A6",
    describe: "combined: 8 DB + 5 passwordless email (2 share a DB email) + 3 SMS",
    dests: ["D1", "D2", "D3", "D4", "D5"],
    // The DB half stores username and phone natively, so D4 (username
    // required) and D5 (phone and username off) have something to act on.
    sourceConfig: async () => {
      await useConnection("A6", { attributes: A6_ATTRIBUTES })();
      await useSms();
    },
    users: (all) => {
      const db = mix({ "email-only": 4, both: 4 })(all);
      return [
        ...mix({ "phone-only": 3 })(all).map((u) => ({ ...u, id: `sms-${u.id}` })),
        ...db,
        // Shared emails come from DB users with nothing else to lose. Which
        // twin the CLI keeps depends on Auth0's export order (cli-bugs #9),
        // so sharing a username- or phone-holder makes the counts flip.
        ...shared(db).map((u) => ({
          ...u,
          id: `pl-${u.id}`,
          hasPassword: false,
          username: null,
          phone: null,
        })),
        ...Array.from({ length: 3 }, (_, i) => ({
          ...db[i],
          id: `pl-new-${i}`,
          email: `passwordless${i}@example.com`,
          hasPassword: false,
          username: null,
          phone: null,
        })),
      ];
    },
    async seed(users, seedPassword) {
      const isPasswordless = (u: SeedUser) => u.id.startsWith("pl-");
      const isSms = (u: SeedUser) => u.id.startsWith("sms-");
      await seedDatabase(
        users.filter((u) => !isPasswordless(u) && !isSms(u)),
        seedPassword,
      );
      await seedPasswordless(users.filter(isPasswordless));
      await seedSms(users.filter(isSms));
    },
    // The shared emails are the point: Clerk keeps one user per email.
    expect: (clerk, seeded, dest) => {
      if (dest !== "D1") return [];
      const db = seeded.filter((u) => !u.id.startsWith("pl-") && !u.id.startsWith("sms-"));
      if (shared(db).length !== A6_SHARED)
        return [`only ${shared(db).length} plain DB users to share an email with`];
      const sms = seeded.filter((u) => u.id.startsWith("sms-"));
      const want = {
        total: seeded.length - A6_SHARED,
        withUsername: db.filter((u) => u.username).length,
        withPhone: db.filter((u) => u.phone).length + sms.length,
      };
      return Object.entries(want)
        .filter(([k, v]) => clerk[k as keyof typeof want] !== v)
        .map(([k, v]) => `${k}: expected ${v}, got ${clerk[k as keyof typeof want]}`);
    },
  },
  {
    id: "A7",
    describe: "edge cases: blocked, unverified email, heavy metadata, custom user_id",
    sourceConfig: useConnection("A7", {}),
    users: (all) =>
      mix({ "email-only": 5, both: 5 })(all).map((u, i) => {
        switch (i % 5) {
          case 0:
            return { ...u, banned: true };
          case 1:
            return { ...u, emailVerified: false };
          case 2:
            return { ...u, metadata: HEAVY_METADATA };
          case 3:
            return { ...u, sourceId: `seed-${u.id}` };
          default:
            return u;
        }
      }),
    expect: (clerk, seeded, dest, users) => {
      if (dest !== "D1") return [];
      const issues = expectLanded({ ...noPasswords, withUsername: 0, withPhone: 0 })(
        clerk,
        seeded,
        dest,
      );
      const unverified = seeded.filter((u) => !u.emailVerified).length;
      if (clerk.total - clerk.withVerifiedEmail !== unverified)
        issues.push(
          `unverified emails: expected ${unverified}, got ${clerk.total - clerk.withVerifiedEmail}`,
        );
      const custom = auth0Ids("auth0|seed-")(users);
      if (custom !== seeded.filter((u) => u.sourceId).length)
        issues.push(`custom user_id external IDs: got ${custom}`);
      const heavy = users.filter(
        (u) => (u.privateMetadata as { plan?: string }).plan === "enterprise",
      ).length;
      if (heavy !== seeded.filter((u) => u.metadata).length)
        issues.push(`app_metadata → private metadata: got ${heavy}`);
      return issues;
    },
  },
];

const HEAVY_METADATA = {
  user: {
    preferences: { theme: "dark", locale: "fr-CA", notifications: { email: true, sms: false } },
    tags: ["beta", "early-adopter", "migrated"],
    bio: "x".repeat(2000),
  },
  app: { plan: "enterprise", roles: ["admin", "billing"], limits: { seats: 25 } },
};
