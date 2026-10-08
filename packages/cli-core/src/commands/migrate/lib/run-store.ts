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
 * Everything `clerk migrate` records lives here, so there is no second record
 * to drift out of step.
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
/**
 * `creating` is written as `POST /v1/users` goes out, and stays the latest line
 * when no answer says whether the create landed (an abort, a network error, a
 * 5xx). The user may then exist in Clerk without its ID on record, so `undo`
 * and a continued run look it up by `external_id`.
 */
export type UserStatus = "creating" | "created" | "failed" | "skipped" | "deleted" | "exported";

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

/** An extra email or phone still to attach to a created user. */
export type PendingIdentifier = { kind: "email" | "phone"; value: string; verified: boolean };

export type UserLine = {
  sourceId: string;
  clerkId?: string;
  status: UserStatus;
  /**
   * On a `created` line: the extra identifiers not yet attached. A continued
   * run attaches them; a later `created` line without it means they are done.
   */
  pending?: PendingIdentifier[];
  /** Why a user was skipped. */
  reason?: string;
  error?: string;
  code?: string;
  passwordDropped?: boolean;
};

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

/**
 * The PID holding the run's lock, when that process is still alive.
 *
 * This process's own PID counts as stale: in a container the CLI often gets
 * the same PID every run, so a killed run's lock would otherwise read as live.
 */
export function liveLockPid(runsDir: string, id: string): number | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(lockFile(runsDir, id), "utf-8");
  } catch {
    return undefined;
  }
  const pid = Number(raw.trim());
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && isPidAlive(pid)
    ? pid
    : undefined;
}

/** The run's lock file. */
export function lockFile(runsDir: string, id: string): string {
  return path.join(runDir(runsDir, id), LOCK_FILE);
}

const isExists = (error: unknown) => (error as NodeJS.ErrnoException).code === "EEXIST";

/**
 * Takes the run's lock. Created exclusively (`wx`), so two processes can't
 * both read "free" and both write; a stale lock is removed and taken once.
 */
function acquireLock(runsDir: string, id: string): void {
  const file = lockFile(runsDir, id);
  const refuse = (holder: number | undefined): never =>
    throwUsageError(
      `Run ${id} is in use by another process${holder ? ` (PID ${holder})` : ""}. Wait for it to finish, then try again. ` +
        `If that process is not a migrate run, delete ${file}.`,
    );
  const take = () => fs.writeFileSync(file, String(process.pid), { flag: "wx", mode: 0o600 });

  try {
    take();
    return;
  } catch (error) {
    if (!isExists(error)) throw error;
  }
  const holder = liveLockPid(runsDir, id);
  if (holder !== undefined) refuse(holder);
  fs.rmSync(file, { force: true });
  try {
    take();
  } catch (error) {
    // Another process took the stale lock between the remove and the write.
    if (isExists(error)) refuse(liveLockPid(runsDir, id));
    throw error;
  }
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

// --- Writing ---------------------------------------------------------------

function writeRecord(runsDir: string, record: RunRecord): void {
  const file = path.join(runDir(runsDir, record.id), RUN_FILE);
  // Written whole and renamed into place, so a reader never sees half a file.
  const temp = `${file}.tmp`;
  fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
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
   * `partial` when any user failed, was skipped or may not have been created,
   * `complete` otherwise.
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
    // Throws when the line cannot be written: a user created with no record is
    // beyond both `undo` and a re-run, so the create it precedes must not go out.
    append(line) {
      // Owner-only like the folder: the lines carry emails and phones.
      fs.appendFileSync(usersFile, `${JSON.stringify(line)}\n`, { mode: 0o600 });
    },
    update(patch) {
      run.record = { ...run.record, ...patch };
      writeRecord(runsDir, run.record);
    },
    finish() {
      const counts = countLines(latestUserLines(runsDir, run.record.id).values());
      const unfinished = (counts.failed ?? 0) + (counts.skipped ?? 0) + (counts.creating ?? 0);
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
  // Owner-only: a run's files hold user data.
  fs.mkdirSync(runsDir, { recursive: true, mode: 0o700 });
  // Created exclusively: two runs started in the same second share an ID one
  // time in 65,536, and must not share a folder.
  let id = newRunId();
  for (;;) {
    try {
      fs.mkdirSync(runDir(runsDir, id), { mode: 0o700 });
      break;
    } catch (error) {
      if (!isExists(error)) throw error;
      id = newRunId();
    }
  }
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
