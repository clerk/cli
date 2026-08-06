/**
 * Enumerating and reading the cwd-relative `./logs/` directory.
 *
 * The standalone migration-tool re-read the directory inside both of its log
 * commands to build their pickers. `list`, `clean` and `convert` all share
 * this instead, which is also what makes `logs list` nearly free.
 */

import fs from "node:fs";
import path from "node:path";
import { getLogDir } from "./logger.ts";

/** The run that produced a log file, read from its filename prefix. */
export type LogKind = "migration" | "deletion" | "export" | "unknown";

const FILENAME_PATTERN = /^(migration|user-deletion|export)-(.+)\.log$/;

const KIND_BY_PREFIX: Record<string, LogKind> = {
  migration: "migration",
  "user-deletion": "deletion",
  export: "export",
};

export type LogFile = {
  name: string;
  path: string;
  kind: LogKind;
  /** Timestamp as recorded in the filename, or `""` for an unrecognized name. */
  timestamp: string;
  sizeBytes: number;
  /** Non-empty NDJSON lines, malformed ones included. */
  entryCount: number;
};

export function classifyLogFile(name: string): { kind: LogKind; timestamp: string } {
  const match = FILENAME_PATTERN.exec(name);
  if (!match) return { kind: "unknown", timestamp: "" };
  return { kind: KIND_BY_PREFIX[match[1] as string] ?? "unknown", timestamp: match[2] as string };
}

function countEntries(filePath: string): number {
  try {
    return fs
      .readFileSync(filePath, "utf-8")
      .split("\n")
      .filter((line) => line.trim().length > 0).length;
  } catch {
    // An unreadable file still belongs in the listing; its count is unknown.
    return 0;
  }
}

/**
 * Every `.log` file in `./logs/`, newest first.
 *
 * @returns An empty array when the directory is absent — "no logs yet" and "no
 *   logs directory" are the same thing to every caller.
 */
export function listLogFiles(): LogFile[] {
  const dir = getLogDir();
  if (!fs.existsSync(dir)) return [];

  const files: LogFile[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".log")) continue;

    const filePath = path.join(dir, name);
    let stats: fs.Stats;
    try {
      stats = fs.statSync(filePath);
    } catch {
      continue;
    }
    if (!stats.isFile()) continue;

    files.push({
      name,
      path: filePath,
      ...classifyLogFile(name),
      sizeBytes: stats.size,
      entryCount: countEntries(filePath),
    });
  }

  // Sort on the timestamp, not the filename: the kind prefix sorts first in a
  // filename comparison, which would interleave a run from January ahead of one
  // from March purely because "user-deletion" > "migration". Timestamps are
  // ISO-ish and zero-padded, so lexical order is chronological. Names without
  // one sort last, then alphabetically.
  return files.sort(
    (a, b) => b.timestamp.localeCompare(a.timestamp) || a.name.localeCompare(b.name),
  );
}

/** Resolves a user-supplied name or path to a log file in `./logs/`. */
export function findLogFile(nameOrPath: string): LogFile | undefined {
  const wanted = path.basename(nameOrPath);
  return listLogFiles().find((file) => file.name === wanted);
}

export type NdjsonLineError = {
  /** 1-indexed line number in the source file. */
  line: number;
  message: string;
};

export type NdjsonReadResult = {
  entries: unknown[];
  errors: NdjsonLineError[];
};

/**
 * Parses an NDJSON file line by line.
 *
 * Malformed lines are collected with their line numbers rather than aborting
 * the read: a run killed mid-write leaves one truncated final line, and the
 * hundreds of complete entries before it are still worth having.
 */
export function readNdjson(filePath: string): NdjsonReadResult {
  const entries: unknown[] = [];
  const errors: NdjsonLineError[] = [];

  const lines = fs.readFileSync(filePath, "utf-8").split("\n");
  for (const [index, line] of lines.entries()) {
    if (line.trim().length === 0) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      errors.push({ line: index + 1, message: (error as Error).message });
    }
  }

  return { entries, errors };
}

/** Human-readable file size. */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
