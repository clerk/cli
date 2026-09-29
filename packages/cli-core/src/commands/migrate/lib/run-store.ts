/**
 * The run store: the one place `clerk migrate` keeps state.
 *
 * Every import, export and undo is a run. A run is a folder under the runs
 * directory holding:
 *
 * - `run.json` — what ran, against what, from which file, and how it ended.
 * - `users.ndjson` — one line per user outcome. The last line for a source ID
 *   wins, so a continued run appends rather than rewrites.
 * - `lock` — the PID of the process working on the run. A live PID refuses a
 *   second writer; a dead one, or a run with no `finishedAt`, means the run
 *   was interrupted.
 *
 * `runs`, `undo`, re-runs and exports all read or write it, so there is no
 * second record to drift out of step.
 *
 * Appends are synchronous so a run interrupted with Ctrl-C still leaves a
 * complete record of everything already processed.
 */

import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { resolveProfile } from "../../../lib/config.ts";
import { throwUsageError } from "../../../lib/errors.ts";
import { ensureGitignoreEntry, getGitRepoRoot } from "../../../lib/git.ts";
import { log } from "../../../lib/log.ts";

/** Overrides the runs directory, below `--runs-dir`. */
export const RUNS_DIR_ENV = "CLERK_MIGRATE_DIR";

/** The `--runs-dir` option every migrate subcommand takes. */
export const RUNS_DIR_FLAG = "--runs-dir <path>";
export const RUNS_DIR_DESCRIPTION = `Where migration runs are kept (default: .clerk/migrate in the project, or ${RUNS_DIR_ENV})`;

export type RunKind = "import" | "undo" | "export";
export type RunStatus = "running" | "complete" | "partial" | "undone";
export type UserStatus = "created" | "failed" | "skipped" | "deleted" | "exported";

/**
 * What a run acted on. For an import or undo, the Clerk instance. For an
 * export, the source platform, plus the Clerk instance for `export clerk`.
 */
export type RunTarget = {
  env?: string;
  appId?: string;
  appLabel?: string;
  instanceId?: string;
  instanceType?: string;
  keySource?: string;
  /** The platform an export read from. */
  platform?: string;
};

export type RunFile = { path: string; sha256: string };

export type RunCounts = Partial<Record<UserStatus, number>> & { total: number };

export type RunRecord = {
  id: string;
  kind: RunKind;
  status: RunStatus;
  startedAt: string;
  finishedAt?: string;
  target: RunTarget;
  source?: string;
  /** Content hash of a custom source, so an edited one is a different source. */
  sourceHash?: string;
  file?: RunFile;
  /** The export run an import read its file from. */
  fromExport?: string;
  /** The import run an undo reverses. */
  undoes?: string;
  /** The undo run that reversed this one. */
  undoneBy?: string;
  counts: RunCounts;
};

export type UserLine = {
  sourceId: string;
  clerkId?: string;
  status: UserStatus;
  /** Why a user was skipped. */
  reason?: string;
  error?: string;
  code?: string;
  passwordDropped?: boolean;
};

/** What `runs` shows for a run: its stored status, or how it stopped. */
export type RunState = RunStatus | "interrupted";

const RUN_FILE = "run.json";
const USERS_FILE = "users.ndjson";
const LOCK_FILE = "lock";

// --- Location --------------------------------------------------------------

/**
 * Where the project lives, for the default runs directory.
 *
 * A profile linked by directory names it outright. One linked by git remote
 * or repository names the repository, whose root is the git toplevel. An
 * unlinked directory outside git is its own project.
 */
async function projectRoot(cwd: string): Promise<string> {
  const profile = await resolveProfile(cwd);
  if (profile?.resolvedVia === "directory") return profile.path;
  return (await getGitRepoRoot(cwd)) ?? cwd;
}

/**
 * The runs directory: `--runs-dir`, then `CLERK_MIGRATE_DIR`, then
 * `<project root>/.clerk/migrate`.
 *
 * @param options.write - The caller is about to write a run. The default
 *   location is gitignored first, because run files carry user data.
 */
export async function resolveRunsDir(
  runsDir: string | undefined,
  options: { write?: boolean; cwd?: string } = {},
): Promise<string> {
  const cwd = options.cwd ?? process.cwd();
  if (runsDir) return path.resolve(cwd, runsDir);

  const fromEnv = process.env[RUNS_DIR_ENV];
  if (fromEnv) return path.resolve(cwd, fromEnv);

  const root = await projectRoot(cwd);
  if (options.write) await ensureGitignoreEntry(root, ".clerk/");
  return path.join(root, ".clerk", "migrate");
}

/** The shape of a run ID, so one can be told apart from a file path. */
export const RUN_ID_PATTERN = /^\d{8}-\d{6}-[0-9a-f]{4}$/;

/** The folder one run lives in. */
export function runDir(runsDir: string, id: string): string {
  return path.join(runsDir, id);
}

// --- IDs and hashes --------------------------------------------------------

/**
 * `YYYYMMDD-HHmmss-xxxx`, local time.
 *
 * Sorts by start time, reads as a date, and the random suffix keeps two runs
 * started in the same second apart.
 */
export function newRunId(now: Date = new Date()): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
  const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${date}-${time}-${randomBytes(2).toString("hex")}`;
}

/** Hex sha256 of a file's bytes. */
export function sha256File(file: string): string {
  return createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}

// --- Locking ---------------------------------------------------------------

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The PID holding the run's lock, when that process is still alive. */
export function liveLockPid(runsDir: string, id: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir(runsDir, id), LOCK_FILE), "utf-8");
  } catch {
    return undefined;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 && isPidAlive(pid) ? pid : undefined;
}

function acquireLock(runsDir: string, id: string): void {
  const holder = liveLockPid(runsDir, id);
  if (holder !== undefined && holder !== process.pid) {
    throwUsageError(
      `Run ${id} is in use by another process (PID ${holder}). Wait for it to finish, then try again.`,
    );
  }
  fs.writeFileSync(path.join(runDir(runsDir, id), LOCK_FILE), String(process.pid));
}

// --- Reading ---------------------------------------------------------------

/** One run's record, or `undefined` when the folder holds no readable run. */
export function readRun(runsDir: string, id: string): RunRecord | undefined {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(path.join(runDir(runsDir, id), RUN_FILE), "utf-8"),
    ) as RunRecord;
    return parsed && typeof parsed === "object" && parsed.id === id ? parsed : undefined;
  } catch {
    return undefined;
  }
}

/** Every line of a run's `users.ndjson`, in the order written. */
export function readUserLines(runsDir: string, id: string): UserLine[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(runDir(runsDir, id), USERS_FILE), "utf-8");
  } catch {
    return [];
  }
  const lines: UserLine[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      lines.push(JSON.parse(line) as UserLine);
    } catch {
      // A line cut short by a crash mid-write. Every earlier line still counts.
    }
  }
  return lines;
}

/** Each source ID's latest outcome, in first-seen order. */
export function latestUserLines(runsDir: string, id: string): Map<string, UserLine> {
  const latest = new Map<string, UserLine>();
  for (const line of readUserLines(runsDir, id)) latest.set(line.sourceId, line);
  return latest;
}

/**
 * How a run stands now. A run that never finished and whose process is gone
 * was interrupted, whatever its stored status says.
 */
export function runState(runsDir: string, record: RunRecord): RunState {
  if (record.finishedAt) return record.status;
  return liveLockPid(runsDir, record.id) === undefined ? "interrupted" : "running";
}

/** Every readable run, newest first. */
export function listRuns(runsDir: string): RunRecord[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(runsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => readRun(runsDir, entry.name))
    .filter((record): record is RunRecord => record !== undefined)
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt) || b.id.localeCompare(a.id));
}

// --- Writing ---------------------------------------------------------------

function writeRecord(runsDir: string, record: RunRecord): void {
  const file = path.join(runDir(runsDir, record.id), RUN_FILE);
  // Written whole and renamed into place, so a reader never sees half a file.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
  fs.renameSync(temp, file);
}

/** Totals by each source ID's latest status. */
export function countLines(latest: Iterable<UserLine>): RunCounts {
  const counts: RunCounts = { total: 0 };
  for (const line of latest) {
    counts.total++;
    counts[line.status] = (counts[line.status] ?? 0) + 1;
  }
  return counts;
}

/** A run being written by this process. */
export type Run = {
  readonly runsDir: string;
  readonly dir: string;
  record: RunRecord;
  /** Appends one user outcome. */
  append(line: UserLine): void;
  /** Merges fields into `run.json`. */
  update(patch: Partial<RunRecord>): void;
  /**
   * Counts the outcomes, settles the status and releases the lock.
   *
   * `partial` when any user failed or was skipped, `complete` otherwise.
   */
  finish(): RunRecord;
};

function openRun(runsDir: string, record: RunRecord): Run {
  const dir = runDir(runsDir, record.id);
  const usersFile = path.join(dir, USERS_FILE);

  const run: Run = {
    runsDir,
    dir,
    record,
    append(line) {
      try {
        fs.appendFileSync(usersFile, `${JSON.stringify(line)}\n`);
      } catch (error) {
        // A broken destination must not abort an in-flight migration; the run
        // is still making real progress against the API.
        log.warn(`Could not write to ${usersFile}: ${(error as Error).message}`);
      }
    },
    update(patch) {
      run.record = { ...run.record, ...patch };
      writeRecord(runsDir, run.record);
    },
    finish() {
      const counts = countLines(latestUserLines(runsDir, run.record.id).values());
      const unfinished = (counts.failed ?? 0) + (counts.skipped ?? 0);
      run.update({
        counts,
        status: unfinished > 0 ? "partial" : "complete",
        finishedAt: new Date().toISOString(),
      });
      fs.rmSync(path.join(dir, LOCK_FILE), { force: true });
      return run.record;
    },
  };
  return run;
}

export type StartRunInit = Omit<RunRecord, "id" | "status" | "startedAt" | "counts">;

/** Creates a run folder, takes its lock and writes the first `run.json`. */
export function startRun(runsDir: string, init: StartRunInit): Run {
  const id = newRunId();
  fs.mkdirSync(runDir(runsDir, id), { recursive: true });
  acquireLock(runsDir, id);

  const record: RunRecord = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    counts: { total: 0 },
    ...init,
  };
  writeRecord(runsDir, record);
  log.debug(`migrate: started ${init.kind} run ${id} in ${runsDir}`);
  return openRun(runsDir, record);
}

/**
 * Reopens a finished or interrupted run to keep working on it.
 *
 * @throws UsageError when another live process holds its lock.
 */
export function continueRun(runsDir: string, record: RunRecord): Run {
  acquireLock(runsDir, record.id);
  const run = openRun(runsDir, record);
  run.record = { ...record, status: "running" };
  delete run.record.finishedAt;
  writeRecord(runsDir, run.record);
  log.debug(`migrate: continuing ${record.kind} run ${record.id} in ${runsDir}`);
  return run;
}

/** Merges fields into a run this process is not writing, such as `undoneBy`. */
export function patchRun(runsDir: string, id: string, patch: Partial<RunRecord>): void {
  const record = readRun(runsDir, id);
  if (record) writeRecord(runsDir, { ...record, ...patch });
}
