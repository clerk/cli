/**
 * Resolving a `--db-url` for the database-backed exports.
 *
 * Shared by supabase, authjs and betterauth: all three take one connection
 * string, from a flag, an environment variable, or a prompt.
 */

import { CliError, throwUsageError } from "../../../lib/errors.ts";
import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { password as passwordPrompt } from "../../../lib/prompts.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { detectDbType, isLibsqlUrl, redactConnectionString, type DbPlatform } from "../lib/db.ts";
import { findMigrateEnvValue } from "../lib/env-file.ts";

export type DbExportOptions = {
  dbUrl?: string;
  output?: string;
};

export type ResolveConfig = {
  platform: DbPlatform;
  /** Environment variable checked when `--db-url` is absent. */
  envVar: string;
  prompt: string;
  /** Extra guidance shown before prompting. */
  hint?: string;
};

const URL_SCHEME = /^(postgresql|postgres|mysql|mysql2|libsql):\/\//i;

/**
 * True when the string parses as a URL with a host.
 *
 * A hostname is required: `postgres://` alone parses as a valid URL, and
 * accepting it only defers the failure into the driver.
 */
function parsesAsUrl(value: string): boolean {
  try {
    return new URL(value).hostname.length > 0;
  } catch {
    return false;
  }
}

/**
 * Percent-encodes the credentials when the raw string will not parse as a URL.
 *
 * Dashboards hand out `postgres://user:[YOUR-PASSWORD]@host/db` and people
 * paste their real password in verbatim. A `#`, `@`, `/` or `^` in it makes the
 * whole string unparseable — here and later inside `Bun.SQL` — so encode it for
 * them rather than bouncing a paste they cannot even see (the prompt is
 * masked). Strings that already parse are returned untouched, so a password
 * that was correctly encoded is never double-encoded.
 */
export function normalizeConnectionString(value: string): string {
  const trimmed = value.trim();
  if (!URL_SCHEME.test(trimmed) || parsesAsUrl(trimmed)) return trimmed;

  // Greedy up to the LAST `@`: everything before it is userinfo, so an
  // unencoded `@` inside the password does not split the string early.
  const match = /^([a-z0-9+]+:\/\/)(.*)@([^@]*)$/i.exec(trimmed);
  if (!match) return trimmed;

  const [, scheme = "", userinfo = "", rest = ""] = match;
  const separator = userinfo.indexOf(":");
  const user = separator === -1 ? userinfo : userinfo.slice(0, separator);
  const secret = separator === -1 ? undefined : userinfo.slice(separator + 1);
  const credentials =
    secret === undefined
      ? encodeURIComponent(user)
      : `${encodeURIComponent(user)}:${encodeURIComponent(secret)}`;

  const encoded = `${scheme}${credentials}@${rest}`;
  return parsesAsUrl(encoded) ? encoded : trimmed;
}

/** True for something that could plausibly be a connection string. */
export function looksLikeConnectionString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (URL_SCHEME.test(trimmed)) return parsesAsUrl(trimmed);

  return (
    trimmed.startsWith("file:") || /\.(sqlite3?|db)$/i.test(trimmed) || trimmed.startsWith("./")
  );
}

/**
 * Resolves the connection string: flag, then environment, then a prompt.
 *
 * Prompted as a password so it is not echoed — a connection string carries the
 * database password inline.
 */
export async function resolveDbUrl(
  options: DbExportOptions,
  config: ResolveConfig,
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const fromFlag = options.dbUrl ? normalizeConnectionString(options.dbUrl) : undefined;
  if (fromFlag) {
    if (!looksLikeConnectionString(fromFlag)) {
      throwUsageError(
        `--db-url does not look like a connection string. Expected postgres://…, mysql://…, libsql://… or a SQLite file path.\n` +
          "If the password contains @, # or /, URL-encode it.",
      );
    }
    return fromFlag;
  }

  const located = await findMigrateEnvValue([config.envVar], cwd, env);
  const fromEnv = located ? normalizeConnectionString(located.value) : undefined;
  if (fromEnv) {
    if (looksLikeConnectionString(fromEnv)) return fromEnv;
    // Falling through silently would make the prompt look unexplained.
    log.warn(`${config.envVar} is not a valid connection string; ignoring it.`);
  }

  if (isAgent() || !isHuman()) {
    throwUsageError(
      `\`clerk migrate export ${config.platform}\` needs a database connection and cannot prompt here.\n` +
        `Pass --db-url, or set ${config.envVar}.`,
      undefined,
      undefined,
      [
        {
          command: `clerk migrate export ${config.platform} --db-url "postgres://user:password@host:5432/db"`,
          description: "Export from Postgres",
        },
      ],
    );
  }

  if (config.hint) log.info(dim(config.hint));

  return promptDbUrl(config);
}

/**
 * Asks for a connection string, masked.
 *
 * Masked because a connection string carries the database password inline. The
 * validator runs on the normalized value, so a password that needed encoding is
 * judged as the driver will see it, not as it was typed.
 */
async function promptDbUrl(config: ResolveConfig): Promise<string> {
  const answer = await passwordPrompt({
    message: config.prompt,
    validate: (value) =>
      looksLikeConnectionString(normalizeConnectionString(value ?? ""))
        ? undefined
        : "Expected postgres://…, mysql://…, libsql://… or a SQLite file path",
  });

  return normalizeConnectionString(answer);
}

/**
 * Runs `work` against the database, asking for another connection string each
 * time it fails.
 *
 * A connection string is long, pasted by hand, and wrong in ways nothing can
 * check until something connects: a typo'd host, an expired token, the pooler
 * URL where the direct one was needed, the right server but the wrong database.
 * Ending the command there charges the operator a full re-run — platform, log
 * directory, output path and all — for a single mistyped line, and the string
 * is masked as they type it, so they cannot even see what to correct.
 *
 * Only the database work belongs in `work`: everything retried here is retried
 * whole, and an export that has already written its file must not run twice.
 *
 * `-y`, agent mode and a non-TTY get the failure as before — there is nobody to
 * ask, and a loop that cannot prompt is a loop that cannot end.
 */
export async function withDbRetry<T>(
  dbUrl: string,
  config: ResolveConfig,
  work: (connectionString: string) => Promise<T>,
): Promise<T> {
  let connectionString = dbUrl;

  for (;;) {
    try {
      return await work(connectionString);
    } catch (error) {
      // Everything the database layer raises is a CliError carrying its own
      // explanation; anything else (an interrupt, a bug) is not ours to retry.
      if (!(error instanceof CliError) || !isHuman() || isAgent()) throw error;

      log.error(error.message);
      connectionString = await promptDbUrl(config);
    }
  }
}

/** Describes the target for the run's opening line, credentials removed. */
export function describeTarget(connectionString: string): string {
  const label = isLibsqlUrl(connectionString) ? "libsql" : detectDbType(connectionString);
  return `${label} at ${redactConnectionString(connectionString)}`;
}
