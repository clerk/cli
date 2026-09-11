/**
 * NDJSON migration logs.
 *
 * Ported from the standalone migration-tool's `src/logger.ts`, with one
 * behavioural fix: logs are written relative to the current working directory
 * rather than to `__dirname/../logs`. In a `bun build --compile` binary there
 * is no source tree next to the executable, so the original path would land
 * logs inside wherever the binary happens to live.
 *
 * Writes are synchronous appends so a run interrupted with Ctrl-C still leaves
 * a complete record of everything already processed.
 */

import fs from "node:fs";
import path from "node:path";
import { log } from "../../../lib/log.ts";
import { text } from "../../../lib/prompts.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { envNames, findSetting } from "../settings/registry.ts";
import { findMigrateEnvValue } from "./env-file.ts";
import { loadSettings, saveSettings } from "./settings.ts";
import type {
  DeleteLogEntry,
  ErrorLog,
  ErrorPayload,
  ExportLogEntry,
  ImportLogEntry,
  ValidationErrorPayload,
} from "../types.ts";

/** Where logs go when nobody has said otherwise. */
export const DEFAULT_LOG_DIR = "./logs";

/**
 * The directory settled for this process, once something has settled it.
 *
 * The log writers are synchronous — a run interrupted with Ctrl-C has to leave
 * a complete record of what it already processed — but resolving the directory
 * reads the config, the env files and possibly the operator. So resolution
 * happens once, up front, and every synchronous write reads the answer from
 * here. {@link resolveLogDir} and {@link ensureLogDir} are the only writers.
 */
let settled: string | undefined;

function remember(dir: string): string {
  settled = path.resolve(process.cwd(), dir);
  return settled;
}

/** Forgets the settled directory. Tests only — each one resolves its own. */
export function _resetLogDir(): void {
  settled = undefined;
}

/**
 * Absolute path of the log directory.
 *
 * Falls back to `./logs` when nothing has resolved yet, so a caller that
 * forgets to is wrong about *where*, never broken.
 */
export function getLogDir(): string {
  return settled ?? path.resolve(process.cwd(), DEFAULT_LOG_DIR);
}

/** The `log-dir` setting, which owns both the env var and the config key. */
const LOG_DIR = findSetting("log-dir") as NonNullable<ReturnType<typeof findSetting>>;

/**
 * The directory the operator has already chosen, by either route.
 *
 * The environment wins over the remembered value, matching every other setting
 * the CLI resolves: a variable exported for one shell is the narrower, more
 * deliberate statement of the two.
 */
async function chosenLogDir(): Promise<string | undefined> {
  const located = await findMigrateEnvValue(envNames(LOG_DIR));
  if (located?.value) return located.value;
  return (await loadSettings()).logDir;
}

/**
 * Settles the log directory without asking: environment, then the saved
 * setting, then `./logs`.
 *
 * For the read-only log commands. Landing on the default here does not save it
 * — an operator who has only ever *listed* logs has still made no choice, and
 * recording one on their behalf would skip the question forever.
 */
export async function resolveLogDir(): Promise<string> {
  return remember((await chosenLogDir()) ?? DEFAULT_LOG_DIR);
}

/**
 * Settles the log directory, asking a human who has not chosen yet.
 *
 * Migration logs are the only record of which users landed and which failed,
 * and `migrate delete` reads them to undo a run — so where they go is worth one
 * question, once per project, before the first thing is written. The answer is
 * saved, so it is asked once and never again.
 *
 * `-y`, agent mode and a non-TTY take the default rather than a prompt they
 * cannot answer, and save nothing: the question stays open for the first
 * interactive run.
 */
export async function ensureLogDir(): Promise<string> {
  const chosen = await chosenLogDir();
  if (chosen) return remember(chosen);
  if (!isHuman() || isAgent()) return remember(DEFAULT_LOG_DIR);

  const answer = await text({
    message: "Where should migration logs be saved?",
    default: DEFAULT_LOG_DIR,
    placeholder: DEFAULT_LOG_DIR,
  });
  const dir = answer.trim() || DEFAULT_LOG_DIR;

  await saveSettings({ ...(await loadSettings()), logDir: dir });
  log.info(
    `Saving migration logs to ${dir}. Change it with \`clerk migrate settings set log-dir <path>\`.`,
  );

  return remember(dir);
}

/**
 * Settles where this run's logs go, and stamps it.
 *
 * Every command that writes a log starts here rather than calling
 * {@link getDateTimeStamp} directly, so there is no path on which a log file is
 * named before its directory has been resolved.
 */
export async function startLogging(): Promise<string> {
  await ensureLogDir();
  return getDateTimeStamp();
}

/**
 * The log directory the way the user would type it from here.
 *
 * Relative (`./logs`) when it sits under the current directory, absolute when
 * it does not — a path the reader can paste either way, without a home
 * directory's worth of prefix on the common case.
 */
export function displayLogDir(): string {
  const dir = getLogDir();
  const relative = path.relative(process.cwd(), dir);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return dir;
  return `.${path.sep}${relative}`;
}

/** Absolute path of the log file a run with this timestamp writes to. */
export function getLogFilePath(logFile: string, dateTime: string): string {
  // Colons are illegal in Windows filenames, and the timestamp is an ISO string.
  return path.join(getLogDir(), `${logFile}-${dateTime}.log`.replace(/:/g, "-"));
}

/** ISO timestamp without milliseconds — the log-file name discriminator. */
export function getDateTimeStamp(): string {
  return new Date().toISOString().split(".")[0] ?? "";
}

function appendToLogFile(fullPath: string, entry: unknown): void {
  try {
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.appendFileSync(fullPath, `${JSON.stringify(entry)}\n`);
  } catch (error) {
    // A broken log destination must not abort an in-flight migration; the run
    // is still making real progress against the API.
    log.warn(`Could not write migration log: ${(error as Error).message}`);
  }
}

/** Writes each error in a failed API call as its own NDJSON line. */
export function errorLogger(payload: ErrorPayload, dateTime: string): void {
  for (const err of payload.errors) {
    const entry: ErrorLog = {
      type: "User Creation Error",
      userId: payload.userId,
      status: payload.status,
      error: err.longMessage ?? err.message,
    };
    appendToLogFile(getLogFilePath("import", dateTime), entry);
  }
}

/** Writes a user that failed schema validation before any API call. */
export function validationLogger(payload: ValidationErrorPayload, dateTime: string): void {
  appendToLogFile(getLogFilePath("import", dateTime), {
    userId: payload.userId,
    status: "fail" as const,
    error: payload.error,
    path: payload.path,
    row: payload.row,
  });
}

/** Writes the outcome of one import attempt. */
export function importLogger(entry: ImportLogEntry, dateTime: string): void {
  appendToLogFile(getLogFilePath("import", dateTime), entry);
}

/**
 * Writes the outcome of one deletion attempt.
 *
 * A separate `delete-` file rather than another line in the import log: undoing
 * a migration is its own run, and mixing the two would make "what did this
 * import do" unanswerable after an undo.
 */
export function deleteLogger(entry: DeleteLogEntry, dateTime: string): void {
  appendToLogFile(getLogFilePath("delete", dateTime), entry);
}

/**
 * Writes the outcome of exporting one user.
 *
 * Its own `export-` file for the same reason deletes get theirs: an export is a
 * distinct run, and `migrate logs list` reports each kind separately.
 */
export function exportLogger(entry: ExportLogEntry, dateTime: string): void {
  appendToLogFile(getLogFilePath("export", dateTime), entry);
}

/** Writes each error in a failed deletion as its own NDJSON line. */
export function deleteErrorLogger(payload: ErrorPayload, dateTime: string): void {
  for (const err of payload.errors) {
    const entry: ErrorLog = {
      type: "User Deletion Error",
      userId: payload.userId,
      status: payload.status,
      error: err.longMessage ?? err.message,
    };
    appendToLogFile(getLogFilePath("delete", dateTime), entry);
  }
}
