/**
 * The database-backed exports, driven against a real SQLite database:
 * resolving the connection string, the Supabase export's row mapping, the
 * Auth.js export's table detection, the Better Auth export's schema
 * detection, and connection failures.
 *
 * SQLite because it is the one engine that needs no container, and it
 * exercises the same client, the same query building and the same plugin
 * detection path (via `PRAGMA` rather than `information_schema`). Postgres and
 * MySQL are covered by the manual matrix run recorded in the ticket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { UserLine } from "../lib/run-store.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { createDbClient, type DbClient } from "../lib/db.ts";
import {
  buildAuthJsExport,
  buildAuthJsQuery,
  exportAuthJs,
  fetchAuthJsAccounts,
  fetchAuthJsUsers,
} from "./authjs.ts";
import {
  buildBetterAuthExport,
  buildBetterAuthQuery,
  detectSchema,
  exportBetterAuth,
  PLUGIN_COLUMNS,
} from "./betterauth.ts";
import {
  buildSupabaseExport,
  exportSupabase,
  fetchSupabaseUsers,
  SUPABASE_DB,
} from "./supabase.ts";
import {
  dialectRefusal,
  looksLikeConnectionString,
  normalizeConnectionString,
  resolveDbUrl,
} from "./db-options.ts";

import { transformUsers } from "../lib/transform.ts";

const captured = useCaptureLog();

let workDir: string;
let originalCwd: string;
let counter = 0;

beforeAll(() => {
  originalCwd = process.cwd();
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-dbexp-")));
  process.chdir(workDir);
});

afterAll(() => {
  process.chdir(originalCwd);
  fs.rmSync(workDir, { recursive: true, force: true });
});

beforeEach(() => {
  fs.rmSync(path.join(workDir, ".clerk"), { recursive: true, force: true });
});

/** Builds a fresh SQLite file so each test starts from a known schema. */
function makeDb(build: (db: Database) => void): string {
  const file = path.join(workDir, `db-${counter++}.sqlite`);
  const db = new Database(file, { create: true });
  build(db);
  db.close();
  return file;
}

function betterAuthDb(pluginColumns: string[], rows: Record<string, unknown>[] = []): string {
  return makeDb((db) => {
    const extra = pluginColumns.map((column) => `, "${column}" TEXT`).join("");
    db.run(
      `CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, "emailVerified" INTEGER, name TEXT,
       "createdAt" TEXT, "updatedAt" TEXT${extra})`,
    );
    db.run(`CREATE TABLE "account" (id TEXT, "userId" TEXT, "providerId" TEXT, password TEXT)`);
    for (const row of rows) {
      const keys = Object.keys(row);
      db.run(
        `INSERT INTO "user" (${keys.map((k) => `"${k}"`).join(",")}) VALUES (${keys.map(() => "?").join(",")})`,
        keys.map((k) => row[k]) as never[],
      );
    }
  });
}

async function withClient<T>(file: string, work: (client: DbClient) => Promise<T>): Promise<T> {
  const client = await createDbClient(file);
  try {
    return await work(client);
  } finally {
    await client.close();
  }
}

describe("looksLikeConnectionString", () => {
  test.each([
    ["postgres://u:p@h:5432/db", true],
    ["mysql://u:p@h:3306/db", true],
    ["./db.sqlite", true],
    ["file:./db.sqlite", true],
    ["/abs/app.db", true],
    ["", false],
    ["   ", false],
    ["just some words", false],
    ["postgres://", false],
  ])("%p -> %p", (input, expected) => {
    expect(looksLikeConnectionString(input)).toBe(expected);
  });
});

describe("normalizeConnectionString", () => {
  test("encodes a password pasted in raw", () => {
    const raw = "postgres://postgres:aB#c%92^d@db.example.supabase.co:5432/postgres";
    const normalized = normalizeConnectionString(raw);

    expect(looksLikeConnectionString(normalized)).toBe(true);
    expect(decodeURIComponent(new URL(normalized).password)).toBe("aB#c%92^d");
    expect(new URL(normalized).hostname).toBe("db.example.supabase.co");
  });

  test("encodes an unencoded @ in the password", () => {
    const normalized = normalizeConnectionString("postgres://u:p@ss@host:5432/db");

    expect(decodeURIComponent(new URL(normalized).password)).toBe("p@ss");
    expect(new URL(normalized).hostname).toBe("host");
  });

  // A bare `%` parses as a URL but fails the driver's decode with "URI error".
  test("encodes a bare % in a password", () => {
    const normalized = normalizeConnectionString("postgres://u:50%off@host:5432/db");

    expect(decodeURIComponent(new URL(normalized).password)).toBe("50%off");
  });

  test("leaves an already-valid string alone", () => {
    const encoded = "postgres://u:p%40ss@host:5432/db";
    expect(normalizeConnectionString(encoded)).toBe(encoded);
  });

  test("leaves non-URL forms alone", () => {
    expect(normalizeConnectionString("  ./db.sqlite  ")).toBe("./db.sqlite");
  });
});

describe("resolveDbUrl", () => {
  const config = { platform: "authjs" as const, envVar: "AUTHJS_DB_URL", prompt: "url" };

  test("prefers the flag", async () => {
    const url = await resolveDbUrl({ dbUrl: "postgres://u:p@h/db" }, config, {
      AUTHJS_DB_URL: "mysql://u:p@h/db",
    });
    expect(url).toBe("postgres://u:p@h/db");
  });

  test("falls back to the environment variable", async () => {
    expect(await resolveDbUrl({}, config, { AUTHJS_DB_URL: "mysql://u:p@h/db" })).toBe(
      "mysql://u:p@h/db",
    );
  });

  test("encodes a raw password passed to the flag", async () => {
    const url = await resolveDbUrl({ dbUrl: "postgres://u:p#ss@host:5432/db" }, config, {});
    expect(decodeURIComponent(new URL(url).password)).toBe("p#ss");
  });

  test("rejects a flag that is not a connection string, naming the encoding trap", async () => {
    await expect(resolveDbUrl({ dbUrl: "not a url" }, config, {})).rejects.toThrow(/URL-encode it/);
  });

  test("warns and moves on when the environment variable is unusable", async () => {
    // Tests run non-TTY, so it then hits the agent-mode branch.
    await expect(resolveDbUrl({}, config, { AUTHJS_DB_URL: "garbage" })).rejects.toThrow(
      /cannot prompt here/,
    );
    expect(captured.err).toContain("AUTHJS_DB_URL is not a valid connection string");
  });

  test("says the variable is set but unusable, rather than asking for it", async () => {
    await expect(resolveDbUrl({}, config, { [config.envVar]: "garbage" })).rejects.toThrow(
      `${config.envVar} is set, but isn't a connection string`,
    );
  });

  test("names both the flag and the variable when it cannot prompt", async () => {
    await expect(resolveDbUrl({}, config, {})).rejects.toThrow(/--db-url.*AUTHJS_DB_URL/s);
  });
});

describe("authjs export", () => {
  const authJsDb = (table: string) =>
    makeDb((db) => {
      db.run(
        `CREATE TABLE "${table}" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" TEXT)`,
      );
      db.run(`INSERT INTO "${table}" VALUES (?,?,?,?)`, [
        "aj1",
        "Jane Doe",
        "jane@x.dev",
        "2024-01-15",
      ]);
      db.run(`INSERT INTO "${table}" VALUES (?,?,?,?)`, ["aj2", "John Smith", "john@x.dev", null]);
    });

  test("quotes identifiers for the dialect", async () => {
    await withClient(authJsDb("User"), async (client) => {
      expect(buildAuthJsQuery(client, "User")).toContain('"User" u');
      expect(buildAuthJsQuery(client, "User")).toContain('u."emailVerified" AS "email_verified"');
    });
  });

  // `@auth/supabase-adapter` keeps its tables in the `next_auth` schema, and an
  // app's own `public.users` must not answer for it.
  test("on Postgres, reads next_auth.users first, quoting schema and table", async () => {
    const sql: string[] = [];
    const client = {
      dbType: "postgres",
      quote: (identifier: string) => `"${identifier}"`,
      placeholder: (position: number) => `$${position}`,
      close: async () => {},
      query: async (query: string) => {
        sql.push(query);
        if (query.includes('"next_auth"."users"')) return [{ id: "aj1", email: "a@x.dev" }];
        throw new Error('relation "public.users" does not exist');
      },
    } as unknown as DbClient;

    const { rows, table } = await fetchAuthJsUsers(client);

    expect(table).toBe("next_auth.users");
    expect(rows).toHaveLength(1);
    expect(sql[0]).toContain('FROM "next_auth"."users" u');
  });

  // Prisma capitalizes the table, Drizzle does not, and Auth.js has no single
  // schema — so the export tries rather than making the user guess.
  // The table is named as it is stored: SQLite matches `User` to a Drizzle
  // `user` table, which then read as "Read 2 rows from User."
  test.each([["User"], ["user"], ["users"]])(
    "finds the %s table, by its own name",
    async (table) => {
      const { rows, storedName } = await withClient(authJsDb(table), fetchAuthJsUsers);
      expect(rows).toHaveLength(2);
      expect(storedName).toBe(table);
    },
  );

  // SQLite reads an unqualified "emailVerified" that matches no column as the
  // string "emailVerified", which would mark every email verified.
  test("reads a legacy NextAuth table's email_verified, and keeps null unverified", async () => {
    const file = makeDb((db) => {
      db.run(
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified TEXT)`,
      );
      db.run(`INSERT INTO users VALUES (?,?,?,?)`, ["n1", "Nv", "nv@x.dev", null]);
      db.run(`INSERT INTO users VALUES (?,?,?,?)`, ["n2", "V", "v@x.dev", "2024-01-15"]);
    });

    const { rows, table } = await withClient(file, fetchAuthJsUsers);

    expect(table).toBe("users");
    expect(rows.map((row) => row.email_verified)).toEqual([null, "2024-01-15"]);
  });

  // Auth.js's own schemas have no creation time; a legacy NextAuth table does.
  test("keeps a legacy NextAuth table's created_at, and reads one without it", async () => {
    const withCreated = makeDb((db) => {
      db.run(
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified TEXT, created_at TEXT)`,
      );
      db.run(`INSERT INTO users VALUES (?,?,?,?,?)`, ["n1", "N", "n@x.dev", null, "2021-03-04"]);
    });
    const { rows } = await withClient(withCreated, fetchAuthJsUsers);
    expect(buildAuthJsExport(rows).users[0]).toMatchObject({ created_at: "2021-03-04" });

    const without = makeDb((db) => {
      db.run(
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified TEXT)`,
      );
      db.run(`INSERT INTO users VALUES (?,?,?,?)`, ["n1", "N", "n@x.dev", null]);
    });
    const plain = await withClient(without, fetchAuthJsUsers);
    expect(plain.rows).toHaveLength(1);
    expect("created_at" in (buildAuthJsExport(plain.rows).users[0] ?? {})).toBe(false);
  });

  // Postgres keeps a quoted "User" apart from "user"; SQLite does not, so the
  // plural table stands in for the later candidate here.
  test("passes over a candidate table without the columns for a later one", async () => {
    const file = makeDb((db) => {
      db.run(`CREATE TABLE "User" (id TEXT PRIMARY KEY, handle TEXT)`);
      db.run(
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" TEXT)`,
      );
      db.run(`INSERT INTO users VALUES (?,?,?,?)`, ["u1", "U", "u@x.dev", null]);
    });

    const { rows, table } = await withClient(file, fetchAuthJsUsers);

    expect(table).toBe("users");
    expect(rows).toHaveLength(1);
  });

  test("a missing column is an error, not a literal", async () => {
    const file = makeDb((db) => {
      db.run(`CREATE TABLE "User" (id TEXT PRIMARY KEY, email TEXT, "emailVerified" TEXT)`);
      db.run(`INSERT INTO "User" VALUES (?,?,?)`, ["a", "a@x.dev", null]);
    });

    await expect(withClient(file, fetchAuthJsUsers)).rejects.toThrow(/no such column/);
  });

  test("fails clearly when no candidate table exists", async () => {
    const file = makeDb((db) => db.run(`CREATE TABLE unrelated (id TEXT)`));
    await expect(withClient(file, fetchAuthJsUsers)).rejects.toThrow(
      /No Auth.js user table found. Tried User, user, users/,
    );
  });

  test("treats email_verified as a nullable timestamp, not a boolean", () => {
    const { users } = buildAuthJsExport([
      { id: "a", email: "a@x.dev", email_verified: "2024-01-15" },
      { id: "b", email: "b@x.dev", email_verified: null },
    ]);
    expect(users[0]?.email_verified).toBe("2024-01-15");
    expect("email_verified" in (users[1] ?? {})).toBe(false);
  });

  // Postgres and MySQL hand back a Date: the epoch is no verification there either.
  test("a zero-epoch Date exports as unverified", () => {
    const { users } = buildAuthJsExport([
      { id: "a", email: "a@x.dev", email_verified: new Date(0) },
      { id: "b", email: "b@x.dev", email_verified: new Date("2024-01-15T00:00:00Z") },
    ]);
    expect("email_verified" in (users[0] ?? {})).toBe(false);
    expect(users[1]?.email_verified).toBe("2024-01-15T00:00:00.000Z");
  });

  test("counts coverage", () => {
    const { coverage } = buildAuthJsExport([
      { id: "a", email: "a@x.dev", name: "A", email_verified: "2024-01-01" },
      { id: "b" },
    ]);
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have an email address"]).toBe(1);
    expect(byLabel["have a verified email"]).toBe(1);
  });

  test("exports end to end and says which table it read", async () => {
    await exportAuthJs({ dbUrl: authJsDb("User"), output: "authjs.json" });

    const written = JSON.parse(fs.readFileSync(path.join(workDir, "authjs.json"), "utf-8"));
    expect(written).toMatchObject({ clerkMigrate: 1, source: "authjs" });
    expect(written.users).toHaveLength(2);
    expect(captured.err).toContain("Read 2 rows from");
    expect(captured.err).toContain("stores no passwords");
    expect(captured.err).toContain("Credentials provider");
  });
});

describe("authjs OAuth accounts", () => {
  /** Prisma's `User` and `Account`, with aj2 signing in with GitHub and Google. */
  const withAccounts = () =>
    makeDb((db) => {
      db.run(
        `CREATE TABLE "User" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" TEXT)`,
      );
      db.run(`INSERT INTO "User" VALUES (?,?,?,?)`, ["aj1", "Jane", "jane@x.dev", "2024-01-15"]);
      db.run(`INSERT INTO "User" VALUES (?,?,?,?)`, ["aj2", "John", "john@x.dev", null]);
      db.run(`INSERT INTO "User" VALUES (?,?,?,?)`, ["aj3", "Ann", "ann@x.dev", null]);
      db.run(`CREATE TABLE "Account" ("userId" TEXT, type TEXT, provider TEXT)`);
      for (const row of [
        ["aj2", "oauth", "github"],
        ["aj2", "oidc", "google"],
        ["aj2", "oauth", "github"],
        // An email-link or Credentials account is not an OAuth sign-in.
        ["aj3", "email", "email"],
        ["aj1", "credentials", "credentials"],
      ]) {
        db.run(`INSERT INTO "Account" VALUES (?,?,?)`, row);
      }
    });

  test("reads each user's OAuth providers, once each", async () => {
    const accounts = await withClient(withAccounts(), async (client) =>
      fetchAuthJsAccounts(client, (await fetchAuthJsUsers(client)).table),
    );
    expect(Object.fromEntries(accounts ?? [])).toEqual({ aj2: ["github", "google"] });
  });

  test("reads a legacy NextAuth accounts table", async () => {
    const file = makeDb((db) => {
      db.run(
        `CREATE TABLE users (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified TEXT)`,
      );
      db.run(`CREATE TABLE accounts (user_id TEXT, provider_type TEXT, provider_id TEXT)`);
      db.run(`INSERT INTO accounts VALUES (?,?,?)`, ["n1", "oauth", "github"]);
    });
    const accounts = await withClient(file, async (client) => fetchAuthJsAccounts(client, "users"));
    expect(Object.fromEntries(accounts ?? [])).toEqual({ n1: ["github"] });
  });

  test("says there is no account table rather than failing", async () => {
    const file = makeDb((db) => {
      db.run(
        `CREATE TABLE "User" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" TEXT)`,
      );
    });
    expect(
      await withClient(file, async (client) => fetchAuthJsAccounts(client, "User")),
    ).toBeUndefined();
  });

  const rows = [
    { id: "aj1", email: "jane@x.dev", email_verified: "2024-01-15" },
    { id: "aj2", email: "john@x.dev" },
  ];
  const accounts = new Map([["aj2", ["github"]]]);

  // Auth.js leaves an OAuth user's email unverified, and Clerk then neither
  // accepts it as a required email nor links a social sign-in to it.
  test("counts OAuth users with an unverified email, and keeps it unverified", () => {
    const result = buildAuthJsExport(rows, () => {}, { accounts });
    expect(result.users[1]).toEqual({ id: "aj2", email: "john@x.dev", providers: ["github"] });
    expect(result.oauthUnverified).toBe(1);
    expect(result.trusted).toBe(0);
    expect(result.sections).toEqual([
      { title: "OAuth providers", items: [{ label: "github", count: 1 }] },
    ]);
  });

  test("--trust-oauth-emails marks an OAuth user's email verified", () => {
    const now = "2026-10-20T00:00:00.000Z";
    const result = buildAuthJsExport(rows, () => {}, { accounts, trustOauthEmails: true, now });
    expect(result.users[1]).toMatchObject({ email_verified: now, providers: ["github"] });
    // A user already verified keeps their own date.
    expect(result.users[0]).toMatchObject({ email_verified: "2024-01-15" });
    expect(result.trusted).toBe(1);
    expect(result.oauthUnverified).toBe(0);
  });

  test("warns how many OAuth users arrive unverified, and how to trust them", async () => {
    await exportAuthJs({ dbUrl: withAccounts(), output: "oauth.json" });

    const written = JSON.parse(fs.readFileSync(path.join(workDir, "oauth.json"), "utf-8"));
    expect(written.users.find((u: { id: string }) => u.id === "aj2")).toMatchObject({
      providers: ["github", "google"],
    });
    expect(captured.err).toContain("1 user signs in with OAuth and has an unverified email");
    expect(captured.err).toContain("--trust-oauth-emails");
  });

  test("says which emails it trusted, and the risk", async () => {
    await exportAuthJs({ dbUrl: withAccounts(), output: "trusted.json", trustOauthEmails: true });

    const written = JSON.parse(fs.readFileSync(path.join(workDir, "trusted.json"), "utf-8"));
    expect(written.users.find((u: { id: string }) => u.id === "aj2")?.email_verified).toBeString();
    expect(captured.err).toContain("Marked 1 email verified because the user signs in with OAuth");
  });

  // SQLite matches `users` to a table stored as `Users`; the account table is
  // found from the candidate that matched, not the stored casing.
  test("finds the account table beside a user table stored in other casing", async () => {
    const file = makeDb((db) => {
      db.run(
        `CREATE TABLE "Users" (id TEXT PRIMARY KEY, name TEXT, email TEXT, email_verified TEXT)`,
      );
      db.run(`INSERT INTO "Users" VALUES (?,?,?,?)`, ["n1", "Ann", "ann@x.dev", null]);
      db.run(`CREATE TABLE "Accounts" (user_id TEXT, provider_type TEXT, provider_id TEXT)`);
      db.run(`INSERT INTO "Accounts" VALUES (?,?,?)`, ["n1", "oauth", "github"]);
    });

    await exportAuthJs({ dbUrl: file, output: "cased.json", trustOauthEmails: true });

    const written = JSON.parse(fs.readFileSync(path.join(workDir, "cased.json"), "utf-8"));
    expect(written.users[0]).toMatchObject({ providers: ["github"] });
    // The account table was read, so the flag has someone to trust.
    expect(written.users[0].email_verified).toBeString();
    expect(captured.err).toContain("Marked 1 email verified");
    expect(captured.err).toContain("from Users.");
    expect(captured.err).not.toContain("No account table");
  });

  test("warns when there is no account table to read", async () => {
    await exportAuthJs({ dbUrl: authJsDbWithoutAccounts(), output: "plain.json" });
    expect(captured.err).toContain("could not tell who signs in with OAuth");
  });
});

function authJsDbWithoutAccounts(): string {
  return makeDb((db) => {
    db.run(
      `CREATE TABLE "user" (id TEXT PRIMARY KEY, name TEXT, email TEXT, "emailVerified" TEXT)`,
    );
    db.run(`INSERT INTO "user" VALUES (?,?,?,?)`, ["aj1", "Jane", "jane@x.dev", null]);
  });
}

describe("betterauth export", () => {
  test("detects only the plugin columns that exist", async () => {
    await withClient(betterAuthDb(["username", "banned"]), async (client) => {
      expect([...(await detectSchema(client)).plugins].sort()).toEqual(["banned", "username"]);
    });
  });

  test("detects nothing on a core-only schema", async () => {
    await withClient(betterAuthDb([]), async (client) => {
      expect((await detectSchema(client)).plugins.size).toBe(0);
    });
  });

  test("detects every plugin column when all are present", async () => {
    await withClient(betterAuthDb([...PLUGIN_COLUMNS]), async (client) => {
      expect((await detectSchema(client)).plugins.size).toBe(PLUGIN_COLUMNS.length);
    });
  });

  // Selecting a column that is not there fails the whole query, which is why
  // the columns are detected rather than assumed.
  test("selects only detected columns", async () => {
    await withClient(betterAuthDb(["username"]), async (client) => {
      const query = buildBetterAuthQuery(client, await detectSchema(client));
      expect(query).toContain('"username"');
      expect(query).not.toContain('"twoFactorEnabled"');
    });
  });

  test("the built query actually runs against the schema it was built for", async () => {
    const file = betterAuthDb(
      ["username", "role"],
      [{ id: "u1", email: "a@x.dev", username: "a" }],
    );
    const rows = await withClient(file, async (client) =>
      client.query(buildBetterAuthQuery(client, await detectSchema(client))),
    );
    expect(rows).toHaveLength(1);
  });

  // A user who only ever signed in with OAuth has no credential account;
  // an INNER JOIN would drop them and silently shrink the export.
  test("keeps a user with no credential account", async () => {
    const file = betterAuthDb(
      [],
      [
        { id: "u1", email: "a@x.dev" },
        { id: "u2", email: "b@x.dev" },
      ],
    );
    const rows = await withClient(file, async (client) =>
      client.query(buildBetterAuthQuery(client, await detectSchema(client))),
    );
    expect(rows).toHaveLength(2);
  });

  // Better Auth's Drizzle generator writes snake_case unless `camelCase: true`,
  // and `usePlural: true` pluralizes the tables.
  test.each([
    ["snake_case columns", "user", "account"],
    ["snake_case columns and plural tables", "users", "accounts"],
  ])("reads a Drizzle schema with %s", async (_label, userTable, accountTable) => {
    const file = makeDb((db) => {
      db.run(
        `CREATE TABLE "${userTable}" (id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER, name TEXT,
         created_at TEXT, updated_at TEXT, ban_expires TEXT, banned INTEGER)`,
      );
      db.run(
        `CREATE TABLE "${accountTable}" (id TEXT, user_id TEXT, provider_id TEXT, password TEXT)`,
      );
      db.run(
        `INSERT INTO "${userTable}" (id, email, email_verified, banned) VALUES ('u1', 'a@x.dev', 1, 1)`,
      );
      db.run(`INSERT INTO "${accountTable}" VALUES ('a1', 'u1', 'credential', 'salt:hash')`);
    });

    const { rows, schema } = await withClient(file, async (client) => {
      const detected = await detectSchema(client);
      return { rows: await client.query(buildBetterAuthQuery(client, detected)), schema: detected };
    });

    expect([...schema.plugins].sort()).toEqual(["banExpires", "banned"]);
    // Read back under the camelCase names the rest of the export expects.
    expect(rows).toEqual([
      expect.objectContaining({
        id: "u1",
        emailVerified: 1,
        banned: 1,
        password_hash: "salt:hash",
      }),
    ]);
  });

  // Better Auth maps each model's fields on its own, so the two tables can
  // disagree on casing.
  test.each([
    ["snake_case user table, camelCase account table", "snake", "userId", "providerId"],
    ["camelCase user table, snake_case account table", "camel", "user_id", "provider_id"],
  ])("joins a %s", async (_label, userCase, userId, providerId) => {
    const [verified, created, updated] =
      userCase === "snake"
        ? ["email_verified", "created_at", "updated_at"]
        : ["emailVerified", "createdAt", "updatedAt"];
    const file = makeDb((db) => {
      db.run(
        `CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, "${verified}" INTEGER, name TEXT,
         "${created}" TEXT, "${updated}" TEXT)`,
      );
      db.run(
        `CREATE TABLE "account" (id TEXT, "${userId}" TEXT, "${providerId}" TEXT, password TEXT)`,
      );
      db.run(`INSERT INTO "user" (id, email, "${verified}") VALUES ('u1', 'a@x.dev', 1)`);
      db.run(`INSERT INTO "account" VALUES ('a1', 'u1', 'credential', 'salt:hash')`);
    });

    const rows = await withClient(file, async (client) =>
      client.query(buildBetterAuthQuery(client, await detectSchema(client))),
    );

    expect(rows).toEqual([
      expect.objectContaining({ id: "u1", emailVerified: 1, password_hash: "salt:hash" }),
    ]);
  });

  // Each field is mapped on its own, so one table can mix the two casings.
  test("resolves each column on its own when a table mixes casings", async () => {
    const file = makeDb((db) => {
      db.run(
        `CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, email_verified INTEGER, name TEXT,
         "createdAt" TEXT, updated_at TEXT)`,
      );
      db.run(`CREATE TABLE "account" (id TEXT, user_id TEXT, "providerId" TEXT, password TEXT)`);
      db.run(`INSERT INTO "user" (id, email, email_verified) VALUES ('u1', 'a@x.dev', 1)`);
      db.run(`INSERT INTO "account" VALUES ('a1', 'u1', 'credential', 'salt:hash')`);
    });

    const rows = await withClient(file, async (client) =>
      client.query(buildBetterAuthQuery(client, await detectSchema(client))),
    );

    expect(rows).toEqual([
      expect.objectContaining({ id: "u1", emailVerified: 1, password_hash: "salt:hash" }),
    ]);
  });

  test("passes over a `user` table that is not Better Auth's for the plural one", async () => {
    const file = makeDb((db) => {
      db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, handle TEXT)`);
      db.run(
        `CREATE TABLE "users" (id TEXT PRIMARY KEY, email TEXT, "emailVerified" INTEGER, name TEXT,
         "createdAt" TEXT, "updatedAt" TEXT)`,
      );
      db.run(`CREATE TABLE "accounts" (id TEXT, "userId" TEXT, "providerId" TEXT, password TEXT)`);
      db.run(`INSERT INTO "users" (id, email) VALUES ('u1', 'a@x.dev')`);
    });

    const schema = await withClient(file, async (client) => detectSchema(client));

    expect(schema).toMatchObject({ userTable: "users", accountTable: "accounts" });
  });

  test("exports a user with two matching credential accounts once", () => {
    const lines: UserLine[] = [];
    const { users, coverage } = buildBetterAuthExport(
      [
        { id: "u1", email: "a@x.dev", password_hash: "salt:hash" },
        { id: "u1", email: "a@x.dev", password_hash: "salt:hash" },
        { id: "u2", email: "b@x.dev", password_hash: null },
      ],
      (line) => lines.push(line),
    );

    expect(users.map((user) => user.user_id)).toEqual(["u1", "u2"]);
    expect(coverage.find((row) => row.label === "have a password hash")?.count).toBe(1);
    expect(lines).toEqual([
      { sourceId: "u1", status: "exported" },
      { sourceId: "u2", status: "exported" },
    ]);
  });

  // Picking one hash would leave the user unable to sign in with the other;
  // leaving the user out would not migrate them at all.
  test("exports a user whose credential accounts hold different hashes, without a password", () => {
    const lines: UserLine[] = [];
    const { users, coverage } = buildBetterAuthExport(
      [
        { id: "u1", email: "a@x.dev", password_hash: "salt:one" },
        { id: "u1", email: "a@x.dev", password_hash: "salt:two" },
      ],
      (line) => lines.push(line),
    );

    expect(users).toHaveLength(1);
    expect(users[0]).not.toHaveProperty("password_hash");
    expect(users[0]?.password_dropped).toBe(true);
    expect(coverage.find((row) => row.label === "have a password hash")?.count).toBe(0);
    expect(lines).toEqual([
      expect.objectContaining({
        sourceId: "u1",
        status: "exported",
        reason: expect.stringContaining("2 credential accounts with different password hashes"),
      }),
    ]);
    expect(captured.err).toContain("Exported 1 user without a password");
  });

  test("renames camelCase columns onto what the transformer reads", () => {
    const { users } = buildBetterAuthExport([
      { id: "u1", emailVerified: 1, phoneNumber: "+1555", createdAt: "2025-01-01" },
    ]);
    expect(users[0]).toMatchObject({
      user_id: "u1",
      email_verified: 1,
      phone_number: "+1555",
      created_at: "2025-01-01",
    });
  });

  test("exports end to end and reports the detected plugins", async () => {
    const file = betterAuthDb(["username"], [{ id: "u1", email: "a@x.dev", username: "ada" }]);

    await exportBetterAuth({ dbUrl: file, output: "ba.json" });

    expect(captured.err).toContain("Detected plugin columns: username");
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "ba.json"), "utf-8")).users).toHaveLength(
      1,
    );
  });

  test("says so plainly when no plugins are in use", async () => {
    await exportBetterAuth({ dbUrl: betterAuthDb([]), output: "ba2.json" });
    expect(captured.err).toContain("No plugin columns detected");
  });
});

describe("supabase export", () => {
  // The source splits a display or OAuth name, but only when first_name is
  // empty; coalescing them into first_name here would stop it.
  test("selects only the metadata's own first_name as first_name", async () => {
    let sql = "";
    await fetchSupabaseUsers({
      query: async (query: string) => {
        sql = query;
        return [];
      },
    } as unknown as DbClient);
    expect(sql).toContain("raw_user_meta_data->>'first_name' AS first_name");
    expect(sql).not.toContain("display_name");
  });

  // Without the column, the import would fail an anonymous user as having no
  // identifier rather than skip it.
  test("carries is_anonymous, so the import skips an anonymous user", async () => {
    let sql = "";
    await fetchSupabaseUsers({
      query: async (query: string) => {
        sql = query;
        return [];
      },
    } as unknown as DbClient);
    expect(sql).toContain("AS is_anonymous");

    const { users } = buildSupabaseExport([{ id: "anon", is_anonymous: true }]);
    const result = transformUsers(users, "supabase");
    expect(result.validationFailed).toBe(0);
    expect(result.transformedData[0]?.skipReason).toContain("anonymous");
  });

  test("serializes timestamps the transformer can parse", () => {
    const { users } = buildSupabaseExport([
      { id: "u1", email: "a@x.dev", created_at: new Date("2024-01-01T00:00:00Z") },
    ]);
    expect(users[0]?.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  test("omits null columns rather than exporting them", () => {
    const { users } = buildSupabaseExport([
      { id: "u1", email: "a@x.dev", phone: null, last_name: null },
    ]);
    expect("phone" in (users[0] ?? {})).toBe(false);
    expect("last_name" in (users[0] ?? {})).toBe(false);
  });

  test("counts the password hashes, the reason this reads the database", () => {
    const { coverage } = buildSupabaseExport([
      { id: "u1", email: "a@x.dev", encrypted_password: "$2b$10$x" },
      { id: "u2", email: "b@x.dev" },
    ]);
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have a password hash"]).toBe(1);
  });

  // The source splits a metadata name into first and last; so does the count.
  test("counts a first and last name split from the metadata", () => {
    const { coverage } = buildSupabaseExport([
      { id: "u1", email: "a@x.dev", raw_user_meta_data: { full_name: "Gus Smith" } },
      { id: "u2", email: "b@x.dev", raw_user_meta_data: { name: "Ada" } },
      { id: "u3", email: "c@x.dev" },
    ]);
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have a first name"]).toBe(2);
    expect(byLabel["have a last name"]).toBe(1);
  });

  test("keeps a ban Postgres stores as 'infinity', which JSON would write as null", () => {
    const { users } = buildSupabaseExport([
      { id: "u1", email: "a@x.dev", banned_until: Infinity },
      { id: "u2", email: "b@x.dev", banned_until: -Infinity },
    ]);
    expect(users[0]?.banned_until).toBe("9999-12-31T23:59:59.999Z");
    expect(users[1]).not.toHaveProperty("banned_until");
  });

  test("keeps raw_app_meta_data, which the import checks read for providers", () => {
    const { users } = buildSupabaseExport([
      { id: "u1", email: "a@x.dev", raw_app_meta_data: { providers: ["discord"] } },
    ]);
    expect(users[0]?.raw_app_meta_data).toEqual({ providers: ["discord"] });
  });

  test("records one line per exported user", () => {
    const lines: UserLine[] = [];
    buildSupabaseExport([{ id: "u1" }, { id: "u2" }], (line) => lines.push(line));

    expect(lines).toHaveLength(2);
  });
});

// A MySQL zero date can come back as an Invalid Date, whose toISOString throws.
describe("a date that holds no real date", () => {
  const invalid = new Date(Number.NaN);

  test("is no verification in an Auth.js export, and does not throw", () => {
    const { users } = buildAuthJsExport([{ id: "aj1", email: "a@x.dev", email_verified: invalid }]);
    expect(users[0]).not.toHaveProperty("email_verified");
  });

  // SQLite TEXT can hold these. The import reads them as unverified, so the
  // export neither writes them nor counts them as verified.
  test.each([["0"], ["not-a-date"]])("treats an Auth.js %p as unverified", (value) => {
    const { users, coverage } = buildAuthJsExport([
      { id: "aj1", email: "a@x.dev", email_verified: value },
    ]);
    expect(users[0]).not.toHaveProperty("email_verified");
    expect(coverage.find((c) => c.label === "have a verified email")?.count).toBe(0);
  });

  test('lets --trust-oauth-emails mark an OAuth user whose value was "0"', () => {
    const now = "2026-10-21T00:00:00.000Z";
    const { users, trusted } = buildAuthJsExport(
      [{ id: "aj1", email: "a@x.dev", email_verified: "0" }],
      () => {},
      { accounts: new Map([["aj1", ["github"]]]), trustOauthEmails: true, now },
    );
    expect(users[0]).toMatchObject({ email_verified: now });
    expect(trusted).toBe(1);
  });

  // Counted from what is exported, so coverage agrees with the file.
  test.each([
    [
      "supabase",
      () => buildSupabaseExport([{ id: "u1", email: "a@x.dev", email_confirmed_at: invalid }]),
      "have a confirmed email",
    ],
    [
      "betterauth",
      () => buildBetterAuthExport([{ id: "u1", email: "a@x.dev", emailVerified: invalid }]),
      "have a verified email",
    ],
  ])("is not counted as a verified email in a %s export", (_platform, build, label) => {
    expect(build().coverage.find((row) => row.label === label)?.count).toBe(0);
  });

  // Supabase skipped the whole row on the throw; Better Auth ended the export.
  test.each([
    ["supabase", () => buildSupabaseExport([{ id: "u1", created_at: invalid }]).users],
    ["betterauth", () => buildBetterAuthExport([{ id: "u1", createdAt: invalid }]).users],
  ])("is left out of a %s export, which keeps the user", (_platform, build) => {
    const users = build();
    expect(users).toHaveLength(1);
    expect(users[0]).not.toHaveProperty("created_at");
  });
});

describe("connection failures", () => {
  // Supabase is Postgres: anything else would connect and then fail.
  test.each([["mysql://u:p@127.0.0.1:1/db"], ["./definitely-not-here.sqlite"]])(
    "refuses %s before connecting or writing a run",
    async (dbUrl) => {
      await expect(exportSupabase({ dbUrl })).rejects.toThrow(
        /`clerk migrate export supabase` reads a Postgres database/,
      );
      expect(fs.existsSync(path.join(workDir, ".clerk"))).toBe(false);
    },
  );

  // Each retry of a refused connect is a fresh prompt, checked the same way.
  test.each([["mysql://u:p@127.0.0.1:1/db"], ["libsql://db.turso.io"], ["./users.db"]])(
    "the prompt refuses %s for Supabase",
    (dbUrl) => {
      expect(dialectRefusal(SUPABASE_DB, dbUrl)).toContain("reads a Postgres database");
    },
  );

  test("the prompt takes a Postgres URL for Supabase", () => {
    expect(dialectRefusal(SUPABASE_DB, "postgresql://u:p@db.x.supabase.co:5432/postgres")).toBe(
      undefined,
    );
  });

  test("the failure never contains the password", async () => {
    await expect(
      exportSupabase({ dbUrl: "postgres://user:hunter2@127.0.0.1:1/db" }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2") }) as Error,
    );
  });
});
