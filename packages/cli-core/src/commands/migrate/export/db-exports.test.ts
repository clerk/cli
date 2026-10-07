/**
 * The database-backed exports, driven against a real SQLite database:
 * resolving the connection string, the Supabase export's row mapping, the
 * Better Auth export's schema detection, and connection failures.
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
  buildBetterAuthExport,
  buildBetterAuthQuery,
  detectSchema,
  exportBetterAuth,
  PLUGIN_COLUMNS,
} from "./betterauth.ts";
import { buildSupabaseExport, exportSupabase, fetchSupabaseUsers } from "./supabase.ts";
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
  const config = { platform: "supabase" as const, envVar: "SUPABASE_DB_URL", prompt: "url" };

  test("prefers the flag", async () => {
    const url = await resolveDbUrl({ dbUrl: "postgres://u:p@h/db" }, config, {
      SUPABASE_DB_URL: "mysql://u:p@h/db",
    });
    expect(url).toBe("postgres://u:p@h/db");
  });

  test("falls back to the environment variable", async () => {
    expect(await resolveDbUrl({}, config, { SUPABASE_DB_URL: "mysql://u:p@h/db" })).toBe(
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
    await expect(resolveDbUrl({}, config, { SUPABASE_DB_URL: "garbage" })).rejects.toThrow(
      /cannot prompt here/,
    );
    expect(captured.err).toContain("SUPABASE_DB_URL is not a valid connection string");
  });

  test("names both the flag and the variable when it cannot prompt", async () => {
    await expect(resolveDbUrl({}, config, {})).rejects.toThrow(/--db-url.*SUPABASE_DB_URL/s);
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
      exportSupabase({ dbUrl: "postgres://user:hunter2@127.0.0.1:1/db" }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2") }) as Error,
    );
  });
});
