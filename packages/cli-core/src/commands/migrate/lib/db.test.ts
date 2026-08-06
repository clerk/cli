import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError } from "../../../lib/errors.ts";
import {
  createDbClient,
  describeDbError,
  detectDbType,
  redactConnectionString,
  sqlitePath,
  withDbClient,
} from "./db.ts";

let workDir: string;
let dbPath: string;

beforeAll(() => {
  workDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-db-")));
  dbPath = path.join(workDir, "test.sqlite");

  const db = new Database(dbPath, { create: true });
  db.run(`CREATE TABLE "user" (id TEXT PRIMARY KEY, email TEXT, "emailVerified" INTEGER)`);
  db.run(`INSERT INTO "user" VALUES (?, ?, ?)`, ["u1", "a@x.dev", 1]);
  db.run(`INSERT INTO "user" VALUES (?, ?, ?)`, ["u2", "b@x.dev", 0]);
  db.close();
});

afterAll(() => {
  fs.rmSync(workDir, { recursive: true, force: true });
});

describe("detectDbType", () => {
  test.each([
    ["postgres://u:p@h/db", "postgres"],
    ["postgresql://u:p@h/db", "postgres"],
    ["POSTGRES://u:p@h/db", "postgres"],
    ["mysql://u:p@h/db", "mysql"],
    ["mysql2://u:p@h/db", "mysql"],
    ["./db.sqlite", "sqlite"],
    ["file:./db.sqlite", "sqlite"],
    ["/abs/path.db", "sqlite"],
    ["  postgres://u:p@h/db  ", "postgres"],
  ])("%s -> %s", (input, expected) => {
    expect(detectDbType(input)).toBe(expected as never);
  });
});

describe("redactConnectionString", () => {
  test.each([
    ["postgres://user:secret@host:5432/db", "postgres://***@host:5432/db"],
    ["mysql://root:hunter2@127.0.0.1:3306/app", "mysql://***@127.0.0.1:3306/app"],
    ["postgres://host/db", "postgres://host/db"],
  ])("%s -> %s", (input, expected) => {
    expect(redactConnectionString(input)).toBe(expected);
  });

  // An unencoded `@` in the password is the most common mistake, and it is
  // exactly when the string ends up in an error message. Matching the first
  // `@` would leave the rest of the password visible.
  test("redacts a password containing an unencoded @", () => {
    const redacted = redactConnectionString("postgres://user:pa@ss@host/db");
    expect(redacted).toBe("postgres://***@host/db");
    expect(redacted).not.toContain("ss");
  });

  test("redacts a password containing a colon", () => {
    expect(redactConnectionString("postgres://user:a:b:c@host/db")).toBe("postgres://***@host/db");
  });

  test.each([["./db.sqlite"], ["/var/data/app.db"], ["file:./local.sqlite"]])(
    "leaves the credential-free path %s alone",
    (input) => {
      expect(redactConnectionString(input)).toBe(input);
    },
  );
});

describe("sqlitePath", () => {
  test.each([
    ["./db.sqlite", "./db.sqlite"],
    ["file:./db.sqlite", "./db.sqlite"],
    ["file:/abs/db.sqlite", "/abs/db.sqlite"],
    ["./db.sqlite?mode=ro", "./db.sqlite"],
    ["  ./db.sqlite  ", "./db.sqlite"],
  ])("%s -> %s", (input, expected) => {
    expect(sqlitePath(input)).toBe(expected);
  });
});

describe("a sqlite client", () => {
  test("connects and queries", async () => {
    const client = await createDbClient(dbPath);
    try {
      const rows = await client.query<{ id: string }>(`SELECT id FROM "user" ORDER BY id`);
      expect(rows.map((row) => row.id)).toEqual(["u1", "u2"]);
    } finally {
      await client.close();
    }
  });

  test("binds parameters", async () => {
    const client = await createDbClient(dbPath);
    try {
      const rows = await client.query<{ email: string }>(`SELECT email FROM "user" WHERE id = ?`, [
        "u2",
      ]);
      expect(rows[0]?.email).toBe("b@x.dev");
    } finally {
      await client.close();
    }
  });

  test("reports its dialect's placeholder and quoting", async () => {
    const client = await createDbClient(dbPath);
    try {
      expect(client.dbType).toBe("sqlite");
      expect(client.placeholder(1)).toBe("?");
      expect(client.quote("user")).toBe('"user"');
    } finally {
      await client.close();
    }
  });

  test("accepts a file: URL", async () => {
    const client = await createDbClient(`file:${dbPath}`);
    try {
      expect(await client.query(`SELECT 1 AS n`)).toHaveLength(1);
    } finally {
      await client.close();
    }
  });

  // bun:sqlite opens lazily, so without an explicit probe a missing file would
  // surface at the first real query, long after "connecting" finished.
  test("fails at connect time when the file is missing, not mid-export", async () => {
    await expect(createDbClient(path.join(workDir, "nope.sqlite"))).rejects.toThrow(CliError);
  });

  test("names the file in the failure", async () => {
    await expect(createDbClient(path.join(workDir, "nope.sqlite"))).rejects.toThrow(
      /Could not open the SQLite file/,
    );
  });
});

describe("withDbClient", () => {
  test("returns the work's value", async () => {
    expect(await withDbClient(dbPath, undefined, async () => "done")).toBe("done");
  });

  test("closes the client even when the work throws", async () => {
    // A leaked handle keeps the process alive after the export has written its
    // file, which reads as a hang.
    await expect(
      withDbClient(dbPath, undefined, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow(/boom/);

    // The file is still usable, so nothing is holding it open.
    expect(await withDbClient(dbPath, undefined, async () => "reopened")).toBe("reopened");
  });

  test("attaches a hint to a query failure, not just a connection failure", async () => {
    await expect(
      withDbClient(dbPath, undefined, (client) => client.query(`SELECT * FROM missing_table`)),
    ).rejects.toThrow(/expected table was not found/);
  });

  test("passes a CliError through unchanged", async () => {
    await expect(
      withDbClient(dbPath, undefined, async () => {
        throw new CliError("already explained");
      }),
    ).rejects.toThrow(/already explained/);
  });
});

describe("describeDbError", () => {
  const withCode = (code: string, message = "") => Object.assign(new Error(message), { code });

  // Bun reports an unreachable host and a closed port identically, as
  // "Connection closed" — precisely where a bare driver error helps least.
  test.each([
    ["ERR_POSTGRES_CONNECTION_CLOSED", "Connection closed"],
    ["ERR_MYSQL_CONNECTION_CLOSED", "Connection closed"],
  ])("turns %s into host/port guidance", (code, message) => {
    expect(describeDbError(withCode(code, message))).toMatch(/Check the host and port/);
  });

  test("gives Supabase the IPv4 add-on hint, which is the usual cause there", () => {
    const hint = describeDbError(
      withCode("ERR_POSTGRES_CONNECTION_CLOSED", "Connection closed"),
      "supabase",
    );
    expect(hint).toMatch(/pooler connection string/);
    expect(hint).toMatch(/IPv4/);
  });

  test.each([
    ['password authentication failed for user "postgres"'],
    ["Access denied for user 'root'@'localhost' (using password: YES)"],
  ])("recognizes the rejected credentials in %p", (message) => {
    expect(describeDbError(new Error(message))).toMatch(/rejected those credentials/);
  });

  test.each([
    ['relation "auth.users" does not exist'],
    ["no such table: user"],
    ["permission denied for table users"],
  ])("recognizes the missing table in %p", (message) => {
    expect(describeDbError(new Error(message))).toMatch(/table was not found|cannot read it/);
  });

  test("points Supabase at Auth being enabled and the postgres role", () => {
    const hint = describeDbError(new Error('relation "auth.users" does not exist'), "supabase");
    expect(hint).toMatch(/Supabase Auth is enabled/);
    expect(hint).toMatch(/postgres` role/);
  });

  test("recognizes an unopenable SQLite file", () => {
    expect(describeDbError(new Error("unable to open database file"))).toMatch(
      /Could not open the SQLite file/,
    );
  });

  test("still says something useful for an error it does not recognize", () => {
    expect(describeDbError(new Error("something odd"))).toMatch(/Check the connection string/);
  });

  test("never echoes the error's own text, which could carry a connection string", () => {
    const hint = describeDbError(new Error("failed for postgres://user:secret@host/db"));
    expect(hint).not.toContain("secret");
  });
});
