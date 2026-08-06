/**
 * Resolving a `--db-url` for the database-backed exports.
 *
 * Shared by supabase, authjs and betterauth: all three take one connection
 * string, from a flag, an environment variable, or a prompt.
 */

import { throwUsageError } from "../../../lib/errors.ts";
import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { password as passwordPrompt } from "../../../lib/prompts.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { detectDbType, redactConnectionString, type DbPlatform } from "../lib/db.ts";

export type DbExportOptions = {
  dbUrl?: string;
  output?: string;
};

type ResolveConfig = {
  platform: DbPlatform;
  /** Environment variable checked when `--db-url` is absent. */
  envVar: string;
  prompt: string;
  /** Extra guidance shown before prompting. */
  hint?: string;
};

/** True for something that could plausibly be a connection string. */
export function looksLikeConnectionString(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;

  if (/^(postgresql|postgres|mysql|mysql2):\/\//i.test(trimmed)) {
    try {
      // A hostname is required: `postgres://` alone parses as a valid URL, and
      // accepting it only defers the failure into the driver.
      return new URL(trimmed).hostname.length > 0;
    } catch {
      // A password with an unencoded `@` or `#` is the usual cause, and it is
      // worth saying so rather than failing later inside the driver.
      return false;
    }
  }

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
  env: Record<string, string | undefined> = process.env,
): Promise<string> {
  const fromFlag = options.dbUrl?.trim();
  if (fromFlag) {
    if (!looksLikeConnectionString(fromFlag)) {
      throwUsageError(
        `--db-url does not look like a connection string. Expected postgres://…, mysql://… or a SQLite file path.\n` +
          "If the password contains @, # or /, URL-encode it.",
      );
    }
    return fromFlag;
  }

  const fromEnv = env[config.envVar]?.trim();
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

  const answer = await passwordPrompt({
    message: config.prompt,
    validate: (value) =>
      looksLikeConnectionString(value ?? "")
        ? undefined
        : "Expected postgres://…, mysql://… or a SQLite file path",
  });

  return answer.trim();
}

/** Describes the target for the run's opening line, credentials removed. */
export function describeTarget(connectionString: string): string {
  return `${detectDbType(connectionString)} at ${redactConnectionString(connectionString)}`;
}
