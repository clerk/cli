/**
 * The database-backed exports: resolving the connection string, the Supabase
 * export's row mapping, and connection failures against a real SQLite file.
 *
 * SQLite because it is the one engine that needs no container, and it
 * exercises the same client. Postgres and MySQL are covered by the manual
 * matrix run recorded in the ticket.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { DbClient } from "../lib/db.ts";
import type { UserLine } from "../lib/run-store.ts";
import { useCaptureLog } from "../../../test/lib/stubs.ts";
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

  test("says the variable is set but unusable, rather than asking for it", async () => {
    await expect(resolveDbUrl({}, config, { [config.envVar]: "garbage" })).rejects.toThrow(
      `${config.envVar} is set, but isn't a connection string`,
    );
  });

  test("names both the flag and the variable when it cannot prompt", async () => {
    await expect(resolveDbUrl({}, config, {})).rejects.toThrow(/--db-url.*SUPABASE_DB_URL/s);
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
