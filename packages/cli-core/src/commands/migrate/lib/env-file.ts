/**
 * `.env.clerk-migrate` — the migration's own env file.
 *
 * Migration credentials are a Firebase signer key, an Auth0 client secret, a
 * database URL: things the app being migrated has no use for. Writing them into
 * the app's `.env.local` mixes two unrelated sets of config in the file a
 * developer reads every day, so they get their own.
 *
 * Read ahead of `.env`/`.env.local`, so a value set here wins over a stale one
 * left in the app's file. An exported shell variable still beats both — that is
 * {@link findEnvValue}'s contract for every value the CLI resolves.
 *
 * Always added to `.gitignore` on write. The CLI creating a credential-bearing
 * file in someone's repository without that is how one ends up committed.
 */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  findEnvValue,
  parseEnvFile,
  serializeEnvFile,
  type EnvLine,
  type LocatedEnvValue,
} from "../../../lib/dotenv.ts";
import { ensureGitignoreEntry } from "../../../lib/git.ts";
import { log } from "../../../lib/log.ts";

export const MIGRATE_ENV_FILE = ".env.clerk-migrate";

/** Lowest priority first: the migration's own file overrides the app's. */
const MIGRATE_ENV_FILES = [".env", ".env.local", MIGRATE_ENV_FILE] as const;

/**
 * The project env file a value in the environment actually came from, if any.
 *
 * Bun loads `.env`, `.env.local` and friends into `process.env` before the CLI
 * runs, so a variable a developer wrote into `.env.local` reaches
 * {@link findEnvValue} as an environment variable and gets reported as one.
 * That is true but useless: "`ROUNDS` env var" does not tell anyone which of
 * their files to edit.
 *
 * Attribution is by value, not by presence. A file that holds the same key with
 * a *different* value lost to something exported in the shell, and saying
 * `.env.local` there would name the file that is not winning — the one case
 * this column exists to catch. Highest-priority file first, matching the order
 * the runtime loaded them in.
 */
async function fileHolding(
  cwd: string,
  { name, value }: LocatedEnvValue,
): Promise<string | undefined> {
  for (const envFile of [...MIGRATE_ENV_FILES].reverse()) {
    const file = Bun.file(join(cwd, envFile));
    if (!(await file.exists())) continue;

    for (const line of parseEnvFile(await file.text())) {
      if (line.type === "entry" && line.key === name && line.value === value) return envFile;
    }
  }
  return undefined;
}

/** Resolves a migration setting: environment first, then the project's env files. */
export async function findMigrateEnvValue(
  names: string[],
  cwd: string = process.cwd(),
  env: Record<string, string | undefined> = process.env,
): Promise<LocatedEnvValue | undefined> {
  const located = await findEnvValue(cwd, names, { env, files: MIGRATE_ENV_FILES });
  if (!located) return undefined;

  // `findEnvValue` reports the environment before it reads a file, so a value
  // the runtime loaded out of `.env.local` is credited to the variable rather
  // than to the file the user would edit. Put the file back.
  const source = located.source.endsWith(" env var")
    ? ((await fileHolding(cwd, located)) ?? located.source)
    : located.source;

  log.debug(`migrate: ${names[0]} from ${source}`);
  return { ...located, source };
}

/**
 * Merges `values` into the parsed file: existing keys update in place, new ones
 * append.
 *
 * Deliberately not `mergeEnvVars` from `lib/dotenv.ts`. That one prepends a
 * `# Clerk` section header when the file holds none of the keys being written,
 * which is right for `env pull` dropping Clerk keys into an app's shared `.env`
 * — and wrong here twice over: every key in this file is already Clerk's, and
 * writing one setting at a time means the check fires again on every call,
 * stacking a fresh header per `settings set`.
 */
function mergeMigrateEnv(lines: EnvLine[], values: Record<string, string>): EnvLine[] {
  const remaining = { ...values };

  const merged = lines.map((line): EnvLine => {
    if (line.type !== "entry" || !(line.key in remaining)) return line;
    const value = remaining[line.key]!;
    delete remaining[line.key];
    return { type: "entry", key: line.key, value, raw: `${line.key}=${value}` };
  });

  for (const [key, value] of Object.entries(remaining)) {
    merged.push({ type: "entry", key, value, raw: `${key}=${value}` });
  }
  return merged;
}

/**
 * Writes settings into `.env.clerk-migrate`, creating and gitignoring it first.
 *
 * Existing comments, blank lines and key order survive — the file is meant to
 * be hand-edited, so rewriting it wholesale would discard the user's notes.
 */
export async function writeMigrateEnvValues(
  values: Record<string, string>,
  cwd: string = process.cwd(),
): Promise<string> {
  const target = join(cwd, MIGRATE_ENV_FILE);
  const existing = await Bun.file(target)
    .text()
    .catch(() => "");

  await Bun.write(target, serializeEnvFile(mergeMigrateEnv(parseEnvFile(existing), values)));
  await ensureGitignoreEntry(cwd, MIGRATE_ENV_FILE);

  return MIGRATE_ENV_FILE;
}

/** Removes the named settings from `.env.clerk-migrate`, leaving the rest. */
export async function clearMigrateEnvValues(
  names: string[],
  cwd: string = process.cwd(),
): Promise<string[]> {
  const target = join(cwd, MIGRATE_ENV_FILE);
  const existing = await Bun.file(target)
    .text()
    .catch(() => "");
  if (!existing) return [];

  const dropped: string[] = [];
  const kept = parseEnvFile(existing).filter((line) => {
    if (line.type !== "entry" || !names.includes(line.key)) return true;
    dropped.push(line.key);
    return false;
  });

  if (dropped.length === 0) return dropped;

  // A file holding nothing but the comments that described the settings it no
  // longer has is worse than no file: it reads as "there is config here".
  if (kept.some((line) => line.type === "entry")) {
    await Bun.write(target, serializeEnvFile(kept));
  } else {
    await unlink(target).catch(() => {});
    log.debug(`migrate: removed empty ${MIGRATE_ENV_FILE}`);
  }

  return dropped;
}
