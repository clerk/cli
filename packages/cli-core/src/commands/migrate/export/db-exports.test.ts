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
import { useCaptureLog } from "../../../test/lib/stubs.ts";
import { createDbClient, type DbClient } from "../lib/db.ts";
import { getLogDir } from "../lib/logger.ts";
import { buildAuthJsExport, buildAuthJsQuery, exportAuthJs, fetchAuthJsUsers } from "./authjs.ts";
import {
  buildBetterAuthExport,
  buildBetterAuthQuery,
  detectPluginColumns,
  exportBetterAuth,
  PLUGIN_COLUMNS,
} from "./betterauth.ts";
import { buildSupabaseExport } from "./supabase.ts";
import { looksLikeConnectionString, resolveDbUrl } from "./db-options.ts";

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
  fs.rmSync(getLogDir(), { recursive: true, force: true });
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
      expect(buildAuthJsQuery(client, "User")).toContain('"User"');
      expect(buildAuthJsQuery(client, "User")).toContain('"emailVerified" AS "email_verified"');
    });
  });

  // Prisma capitalizes the table, Drizzle does not, and Auth.js has no single
  // schema — so the export tries rather than making the user guess.
  test.each([["User"], ["user"], ["users"]])("finds the %s table", async (table) => {
    const { rows } = await withClient(authJsDb(table), fetchAuthJsUsers);
    expect(rows).toHaveLength(2);
  });

  test("fails clearly when no candidate table exists", async () => {
    const file = makeDb((db) => db.run(`CREATE TABLE unrelated (id TEXT)`));
    await expect(withClient(file, fetchAuthJsUsers)).rejects.toThrow(
      /No Auth.js user table found. Tried User, user, users/,
    );
  });

  test("treats email_verified as a nullable timestamp, not a boolean", () => {
    const { users } = buildAuthJsExport(
      [
        { id: "a", email: "a@x.dev", email_verified: "2024-01-15" },
        { id: "b", email: "b@x.dev", email_verified: null },
      ],
      "2026-01-01T00:00:00",
    );
    expect(users[0]?.email_verified).toBe("2024-01-15");
    expect("email_verified" in (users[1] ?? {})).toBe(false);
  });

  test("counts coverage", () => {
    const { coverage } = buildAuthJsExport(
      [{ id: "a", email: "a@x.dev", name: "A", email_verified: "2024-01-01" }, { id: "b" }],
      "2026-01-01T00:00:00",
    );
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have an email address"]).toBe(1);
    expect(byLabel["have a verified email"]).toBe(1);
  });

  test("exports end to end and says which table it read", async () => {
    await exportAuthJs({ dbUrl: authJsDb("User"), output: "authjs.json" });

    const written = JSON.parse(fs.readFileSync(path.join(workDir, "authjs.json"), "utf-8"));
    expect(written).toHaveLength(2);
    expect(captured.err).toContain("Read 2 row(s) from");
    expect(captured.err).toContain("stores no passwords");
  });
});

describe("betterauth export", () => {
  test("detects only the plugin columns that exist", async () => {
    await withClient(betterAuthDb(["username", "banned"]), async (client) => {
      expect([...(await detectPluginColumns(client))].sort()).toEqual(["banned", "username"]);
    });
  });

  test("detects nothing on a core-only schema", async () => {
    await withClient(betterAuthDb([]), async (client) => {
      expect((await detectPluginColumns(client)).size).toBe(0);
    });
  });

  test("detects every plugin column when all are present", async () => {
    await withClient(betterAuthDb([...PLUGIN_COLUMNS]), async (client) => {
      expect((await detectPluginColumns(client)).size).toBe(PLUGIN_COLUMNS.length);
    });
  });

  // Selecting a column that is not there fails the whole query, which is why
  // the columns are detected rather than assumed.
  test("selects only detected columns", async () => {
    await withClient(betterAuthDb(["username"]), async (client) => {
      const query = buildBetterAuthQuery(client, await detectPluginColumns(client));
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
      client.query(buildBetterAuthQuery(client, await detectPluginColumns(client))),
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
      client.query(buildBetterAuthQuery(client, new Set())),
    );
    expect(rows).toHaveLength(2);
  });

  test("renames camelCase columns onto what the transformer reads", () => {
    const { users } = buildBetterAuthExport(
      [{ id: "u1", emailVerified: 1, phoneNumber: "+1555", createdAt: "2025-01-01" }],
      "2026-01-01T00:00:00",
    );
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
    expect(JSON.parse(fs.readFileSync(path.join(workDir, "ba.json"), "utf-8"))).toHaveLength(1);
  });

  test("says so plainly when no plugins are in use", async () => {
    await exportBetterAuth({ dbUrl: betterAuthDb([]), output: "ba2.json" });
    expect(captured.err).toContain("No plugin columns detected");
  });
});

describe("supabase export", () => {
  test("serializes timestamps the transformer can parse", () => {
    const { users } = buildSupabaseExport(
      [{ id: "u1", email: "a@x.dev", created_at: new Date("2024-01-01T00:00:00Z") }],
      "2026-01-01T00:00:00",
    );
    expect(users[0]?.created_at).toBe("2024-01-01T00:00:00.000Z");
  });

  test("omits null columns rather than exporting them", () => {
    const { users } = buildSupabaseExport(
      [{ id: "u1", email: "a@x.dev", phone: null, last_name: null }],
      "2026-01-01T00:00:00",
    );
    expect("phone" in (users[0] ?? {})).toBe(false);
    expect("last_name" in (users[0] ?? {})).toBe(false);
  });

  test("counts the password hashes, the reason this reads the database", () => {
    const { coverage } = buildSupabaseExport(
      [
        { id: "u1", email: "a@x.dev", encrypted_password: "$2b$10$x" },
        { id: "u2", email: "b@x.dev" },
      ],
      "2026-01-01T00:00:00",
    );
    const byLabel = Object.fromEntries(coverage.map((c) => [c.label, c.count]));
    expect(byLabel["have a password hash"]).toBe(1);
  });

  test("keeps raw_app_meta_data, which --skip-unsupported-providers reads", () => {
    const { users } = buildSupabaseExport(
      [{ id: "u1", email: "a@x.dev", raw_app_meta_data: { providers: ["discord"] } }],
      "2026-01-01T00:00:00",
    );
    expect(users[0]?.raw_app_meta_data).toEqual({ providers: ["discord"] });
  });

  test("logs one NDJSON line per exported user", () => {
    buildSupabaseExport([{ id: "u1" }, { id: "u2" }], "2026-01-01T12:00:00");

    const written = fs.readdirSync(getLogDir());
    expect(written[0]).toBe("export-2026-01-01T12-00-00.log");
    expect(
      fs
        .readFileSync(path.join(getLogDir(), written[0] as string), "utf-8")
        .trim()
        .split("\n"),
    ).toHaveLength(2);
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

  test("the failure never contains the password", async () => {
    await expect(
      exportBetterAuth({ dbUrl: "postgres://user:hunter2@127.0.0.1:1/db" }),
    ).rejects.toThrow(
      expect.objectContaining({ message: expect.not.stringContaining("hunter2") }) as Error,
    );
  });
});
