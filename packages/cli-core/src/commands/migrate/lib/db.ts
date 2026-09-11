/**
 * One query interface over Postgres, MySQL and SQLite.
 *
 * Rewritten from the standalone migration-tool's `src/lib/db.ts`, which used
 * `pg`, `mysql2` and `better-sqlite3`. None of those belong in a statically
 * compiled binary — `better-sqlite3` is a native addon outright — so this runs
 * on `Bun.sql` (Postgres and MySQL) and `bun:sqlite`, both built into the
 * runtime. That swap is the entire reason the `engines.bun` floor exists.
 *
 * **Placeholders are not unified.** `Bun.sql` passes the query through to each
 * server as written, so Postgres wants `$1` and MySQL wants `?` — verified
 * against both. Rather than rewrite SQL strings (Postgres uses `?` as a JSONB
 * operator, so a naive rewriter would corrupt real queries), callers ask the
 * client for the placeholder and the identifier quoting they need. They already
 * build per-dialect SQL for table casing, so this adds no new branching.
 */

import { Database } from "bun:sqlite";
import { SQL } from "bun";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

export type DbType = "postgres" | "mysql" | "sqlite";

export interface DbClient {
  dbType: DbType;
  query<T extends Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** The bind placeholder for the 1-indexed `position`. */
  placeholder(position: number): string;
  /** Quotes an identifier for this dialect. */
  quote(identifier: string): string;
  close(): Promise<void>;
}

/**
 * Reads the database type from a connection string.
 *
 * Anything that is not a recognized URL scheme is treated as a SQLite path,
 * matching how the standalone tool behaved and how users actually pass
 * `./db.sqlite`. `libsql://` (Turso) is SQLite too — it only differs in how
 * the rows are fetched, so callers that branch on the dialect want "sqlite".
 */
export function detectDbType(connectionString: string): DbType {
  const lower = connectionString.trim().toLowerCase();
  if (lower.startsWith("postgresql://") || lower.startsWith("postgres://")) return "postgres";
  if (lower.startsWith("mysql://") || lower.startsWith("mysql2://")) return "mysql";
  return "sqlite";
}

/** True for a remote libsql/Turso URL, which is read over HTTP rather than opened. */
export function isLibsqlUrl(connectionString: string): boolean {
  return /^libsql:\/\//i.test(connectionString.trim());
}

/**
 * Replaces any credentials in a connection string with `***`.
 *
 * Connection strings reach the CLI on the command line and end up in error
 * messages and `--verbose` output. Bun's own errors do not echo them, and
 * nothing here should either.
 */
export function redactConnectionString(connectionString: string): string {
  // Greedy up to the LAST `@`: an unencoded `@` in the password is the most
  // common connection-string mistake, and matching the first one would leave
  // the rest of the password in the message. Everything before the final `@`
  // is userinfo, so redacting all of it is always safe.
  // Non-URL forms (SQLite paths) have no `://` and are left alone.
  // Turso carries its credential as `?authToken=`, not as userinfo.
  return connectionString
    .replace(/^([a-z0-9+]+:\/\/)(.*)@/i, "$1***@")
    .replace(/([?&]authToken=)[^&]*/gi, "$1***");
}

/** Strips a `file:` prefix and any URL query, leaving a filesystem path. */
export function sqlitePath(connectionString: string): string {
  const trimmed = connectionString.trim();
  const withoutScheme = trimmed.startsWith("file:") ? trimmed.slice("file:".length) : trimmed;
  return withoutScheme.split("?")[0] ?? withoutScheme;
}

const QUOTING: Record<DbType, (identifier: string) => string> = {
  // Doubling the delimiter is the escape in every dialect here, so an
  // identifier containing one cannot break out of the quotes.
  postgres: (identifier) => `"${identifier.replace(/"/g, '""')}"`,
  sqlite: (identifier) => `"${identifier.replace(/"/g, '""')}"`,
  mysql: (identifier) => `\`${identifier.replace(/`/g, "``")}\``,
};

function bunSqlClient(connectionString: string, dbType: "postgres" | "mysql"): DbClient {
  const sql = new SQL(connectionString);

  return {
    dbType,
    async query<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
      const rows = await sql.unsafe(query, params);
      return (Array.isArray(rows) ? rows : []) as T[];
    },
    placeholder: dbType === "postgres" ? (position) => `$${position}` : () => "?",
    quote: QUOTING[dbType],
    async close() {
      await sql.close();
    },
  };
}

/**
 * One value in Hrana's wire format, the protocol libsql servers speak.
 *
 * Integers arrive as strings so 64-bit values survive JSON.
 */
type HranaValue = { type: string; value?: string | number; base64?: string };

function decodeHrana(value: HranaValue): unknown {
  switch (value.type) {
    case "null":
      return null;
    case "integer": {
      const raw = String(value.value ?? "0");
      const asNumber = Number(raw);
      // Past 2^53 a number would silently lose digits; ids can get that big.
      return Number.isSafeInteger(asNumber) ? asNumber : BigInt(raw);
    }
    case "float":
      return Number(value.value);
    case "blob":
      // bun:sqlite hands back bytes for a BLOB, so this does too.
      return Buffer.from(value.base64 ?? "", "base64");
    default:
      return value.value ?? null;
  }
}

function encodeHrana(param: unknown): HranaValue {
  if (param === null || param === undefined) return { type: "null" };
  if (typeof param === "bigint") return { type: "integer", value: param.toString() };
  if (typeof param === "boolean") return { type: "integer", value: param ? "1" : "0" };
  if (typeof param === "number") {
    return Number.isInteger(param)
      ? { type: "integer", value: String(param) }
      : { type: "float", value: param };
  }
  if (param instanceof Uint8Array) {
    return { type: "blob", base64: Buffer.from(param).toString("base64") };
  }
  return { type: "text", value: String(param) };
}

/**
 * Talks to a libsql server (Turso) over its HTTP pipeline endpoint.
 *
 * `bun:sqlite` opens local files and cannot reach a remote database, and
 * `@libsql/client` ships native optional dependencies that do not survive
 * `bun build --compile`. The protocol is one POST per statement, so it is
 * fewer lines to speak it directly than to carry the dependency.
 *
 * The token comes from `?authToken=` on the URL — the form the Turso CLI
 * prints — or from `TURSO_AUTH_TOKEN`/`LIBSQL_AUTH_TOKEN`. A self-hosted sqld
 * with auth disabled needs neither, so a missing token is not an error here.
 */
function libsqlClient(
  connectionString: string,
  env: Record<string, string | undefined> = process.env,
): DbClient {
  const url = new URL(connectionString.trim());
  const token = url.searchParams.get("authToken") || env.TURSO_AUTH_TOKEN || env.LIBSQL_AUTH_TOKEN;
  const endpoint = `https://${url.host}/v2/pipeline`;

  return {
    dbType: "sqlite",
    async query<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        // `close` keeps every request stateless: no baton to carry forward.
        body: JSON.stringify({
          requests: [
            { type: "execute", stmt: { sql: query, args: params.map(encodeHrana) } },
            { type: "close" },
          ],
        }),
      });

      if (!response.ok) {
        throw new Error(`libsql request failed: ${response.status} ${response.statusText}`.trim());
      }

      const body = (await response.json()) as {
        results?: {
          type: string;
          error?: { message?: string };
          response?: { result?: { cols?: { name?: string }[]; rows?: HranaValue[][] } };
        }[];
      };

      const first = body.results?.[0];
      if (!first || first.type === "error") {
        throw new Error(first?.error?.message ?? "libsql returned no result");
      }

      const cols = first.response?.result?.cols ?? [];
      const rows = first.response?.result?.rows ?? [];
      return rows.map(
        (row) =>
          Object.fromEntries(
            row.map((value, index) => [cols[index]?.name ?? String(index), decodeHrana(value)]),
          ) as T,
      );
    },
    placeholder: () => "?",
    quote: QUOTING.sqlite,
    close() {
      return Promise.resolve();
    },
  };
}

function sqliteClient(connectionString: string): DbClient {
  const database = new Database(sqlitePath(connectionString), { readonly: true });

  return {
    dbType: "sqlite",
    query<T extends Record<string, unknown>>(query: string, params: unknown[] = []) {
      // bun:sqlite is synchronous; the Promise keeps one interface for callers.
      return Promise.resolve(database.query(query).all(...(params as never[])) as T[]);
    },
    placeholder: () => "?",
    quote: QUOTING.sqlite,
    close() {
      database.close();
      return Promise.resolve();
    },
  };
}

/**
 * Connects to the database a connection string names.
 *
 * @param platform - Tailors the failure hint; the same "Connection closed"
 *   means something different on Supabase than on a local SQLite file.
 */
export async function createDbClient(
  connectionString: string,
  platform?: DbPlatform,
): Promise<DbClient> {
  const dbType = detectDbType(connectionString);

  try {
    if (isLibsqlUrl(connectionString)) {
      const client = libsqlClient(connectionString);
      await client.query("SELECT 1");
      return client;
    }

    if (dbType === "sqlite") {
      const client = sqliteClient(connectionString);
      // bun:sqlite opens lazily, so a missing file would not surface until the
      // first real query — long after the "connecting" spinner has stopped.
      await client.query("SELECT 1");
      return client;
    }

    const client = bunSqlClient(connectionString, dbType);
    await client.query("SELECT 1");
    return client;
  } catch (error) {
    throw connectionError(error, connectionString, platform);
  }
}

export type DbPlatform = "supabase" | "betterauth" | "authjs";

/**
 * Turns a driver error into something a user can act on.
 *
 * Rewritten rather than ported: the standalone tool matched on `pg`'s
 * `ENOTFOUND`/`ETIMEDOUT`, which `Bun.sql` never emits. Bun reports both an
 * unreachable host and a closed port as `ERR_*_CONNECTION_CLOSED` with the
 * message "Connection closed" — exactly the case where a bare driver error
 * helps least.
 */
export function describeDbError(error: unknown, platform?: DbPlatform): string {
  const message = error instanceof Error ? error.message : String(error);
  const code = (error as { code?: string })?.code ?? "";

  if (code.includes("CONNECTION_CLOSED") || /connection closed|econnrefused/i.test(message)) {
    if (platform === "supabase") {
      return (
        "Could not reach the database. Check the host and port in the connection string.\n" +
        "Supabase direct connections need the IPv4 add-on — use the pooler connection string\n" +
        "(Dashboard → Connect → Session pooler), or enable IPv4 under Settings → Add-Ons."
      );
    }
    return "Could not reach the database. Check the host and port, and that the server accepts connections from here.";
  }

  if (/\b401\b|unauthorized|not authorized/i.test(message)) {
    return (
      "The libsql server rejected that token.\n" +
      "Append ?authToken=… to the URL, or set TURSO_AUTH_TOKEN (`turso db tokens create <db>`)."
    );
  }

  if (/password authentication failed|access denied/i.test(message)) {
    return "The database rejected those credentials. Check the user and password in the connection string.";
  }

  if (/does not exist|unknown database|no such table|permission denied/i.test(message)) {
    if (platform === "supabase") {
      return (
        "The auth.users table was not readable. It is created automatically when Supabase Auth is enabled.\n" +
        "Check Authentication is enabled, and connect as the `postgres` role rather than an application role."
      );
    }
    return "The expected table was not found, or the user cannot read it. Check the database name and the user's SELECT permission.";
  }

  if (/unable to open database|sqlitecantopen|no such file/i.test(message)) {
    return "Could not open the SQLite file. Check the path, and that the file exists and is readable.";
  }

  return "Check the connection string, that the server is running, and that it is reachable from here.";
}

function connectionError(
  error: unknown,
  connectionString: string,
  platform?: DbPlatform,
): CliError {
  const message = error instanceof Error ? error.message : String(error);
  return new CliError(
    `Could not connect to ${redactConnectionString(connectionString)}: ${message}\n\n${describeDbError(error, platform)}`,
    { code: ERROR_CODE.USAGE_ERROR },
  );
}

/**
 * Runs `work` against a fresh client and always closes it.
 *
 * A leaked connection keeps the process alive after the export has written its
 * file, which looks like a hang.
 */
export async function withDbClient<T>(
  connectionString: string,
  platform: DbPlatform | undefined,
  work: (client: DbClient) => Promise<T>,
): Promise<T> {
  const client = await createDbClient(connectionString, platform);
  try {
    return await work(client);
  } catch (error) {
    // A query failure carries the same actionable hints as a connection one:
    // a missing table is the most common thing that goes wrong here.
    if (error instanceof CliError) throw error;
    throw new CliError(
      `${error instanceof Error ? error.message : String(error)}\n\n${describeDbError(error, platform)}`,
      { code: ERROR_CODE.USAGE_ERROR },
    );
  } finally {
    await client.close().catch(() => {});
  }
}
