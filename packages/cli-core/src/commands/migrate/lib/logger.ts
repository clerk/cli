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
import type {
  DeleteLogEntry,
  ErrorLog,
  ErrorPayload,
  ExportLogEntry,
  ImportLogEntry,
  ValidationErrorPayload,
} from "../types.ts";

/** Absolute path of the cwd-relative `logs/` directory. */
export function getLogDir(): string {
  return path.join(process.cwd(), "logs");
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
