/**
 * The three database-backed exports, driven against a real SQLite database.
 *
 * SQLite because it is the one engine that needs no container, and it
 * exercises the same client, the same query building and the same plugin
 * detection path (via `PRAGMA` rather than `information_schema`). Postgres and
 * MySQL are covered by the manual matrix run recorded in the ticket.
 */

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import type { UserLine } from "../lib/run-store.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { createDbClient, type DbClient } from "../lib/db.ts";
import { buildAuthJsExport, buildAuthJsQuery, exportAuthJs, fetchAuthJsUsers } from "./authjs.ts";
import {
  buildBetterAuthExport,
  buildBetterAuthQuery,
  detectSchema,
  exportBetterAuth,
  PLUGIN_COLUMNS,
} from "./betterauth.ts";
import { buildSupabaseExport, fetchSupabaseUsers } from "./supabase.ts";
import {
  looksLikeConnectionString,
  normalizeConnectionString,
  resolveDbUrl,
} from "./db-options.ts";

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
  fs.rmSync(path.join(workDir, "exports"), { recursive: true, force: true });
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

  // Prisma capitalizes the table, Drizzle does not, and Auth.js has no single
  // schema — so the export tries rather than making the user guess.
  test.each([["User"], ["user"], ["users"]])("finds the %s table", async (table) => {
    const { rows } = await withClient(authJsDb(table), fetchAuthJsUsers);
    expect(rows).toHaveLength(2);
  });

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

  // Picking one hash would leave the user unable to sign in with the other.
  test("skips a user whose credential accounts hold different hashes, and says so", () => {
    const lines: UserLine[] = [];
    const { users } = buildBetterAuthExport(
      [
        { id: "u1", email: "a@x.dev", password_hash: "salt:one" },
        { id: "u1", email: "a@x.dev", password_hash: "salt:two" },
      ],
      (line) => lines.push(line),
    );

    expect(users).toEqual([]);
    expect(lines).toEqual([
      expect.objectContaining({
        sourceId: "u1",
        status: "skipped",
        error: expect.stringContaining("2 credential accounts with different password hashes"),
      }),
    ]);
    expect(captured.err).toContain("Skipped 1 user with more than one credential account");
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

describe("connection failures", () => {
  afterEach(() => {
    fs.rmSync(path.join(workDir, "exports"), { recursive: true, force: true });
  });

  test("a missing SQLite file fails before anything is written", async () => {
    await expect(exportAuthJs({ dbUrl: "./definitely-not-here.sqlite" })).rejects.toThrow(CliError);
    expect(fs.existsSync(path.join(workDir, "exports"))).toBe(false);
  });

  // Supabase is Postgres: anything else would connect and then fail.
  test.each([["mysql://u:p@127.0.0.1:1/db"], ["./definitely-not-here.sqlite"]])(
    "refuses %s before connecting or writing a run",
    async (dbUrl) => {
      await expect(exportSupabase({ dbUrl })).rejects.toThrow(/Supabase's database is Postgres/);
      expect(fs.existsSync(path.join(workDir, ".clerk"))).toBe(false);
    },
  );

  test("the failure never contains the password", async () => {
    await expect(
      exportBetterAuth({ dbUrl: "postgres://user:hunter2@127.0.0.1:1/db" }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2") }) as Error,
    );
  });
});
