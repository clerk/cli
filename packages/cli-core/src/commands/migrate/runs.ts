/**
 * `clerk migrate runs [run-id]` — what every import, export and undo did.
 *
 * Reads the run store and nothing else. `runs` alone lists every run, newest
 * first. `runs <id>` shows one: its header, counts, the error breakdown, the
 * users that did not make it, and the command to run next.
 */

import path from "node:path";
import { bold, dim, green, red, yellow } from "../../lib/color.ts";
import { throwUsageError } from "../../lib/errors.ts";
import { quoteArg } from "../../lib/json-body.ts";
import { log } from "../../lib/log.ts";
import { tallyError } from "./lib/failures.ts";
import {
  continueFinishes,
  latestUserLines,
  listRuns,
  importsOfFile,
  undosOf,
  readRun,
  resolveRunsDir,
  runDir,
  runState,
  sha256File,
  type RunCounts,
  type RunRecord,
  type RunState,
  type UserLine,
  USERS_FILE,
  noRunMessage,
  withLiveCounts,
} from "./lib/run-store.ts";
import { carryFlags, importFlags, undoCommand, withFlags } from "./lib/carry-flags.ts";
import { plural } from "./lib/plural.ts";
import { describeTarget, isStandInInstanceId, laterCarry } from "./lib/target.ts";

export type RunsOptions = {
  json?: boolean;
  runsDir?: string;
};

/** How many users of each list `runs <id>` prints before pointing at the file. */
const USER_LIST_LIMIT = 20;

function formatDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

function colorState(state: RunState): string {
  if (state === "complete") return green(state);
  if (state === "partial" || state === "interrupted") return yellow(state);
  if (state === "undone") return dim(state);
  return state;
}

// `creating`: a create no answer confirmed. Clerk may hold the user.
const COUNT_LABELS: Partial<Record<keyof RunCounts, string>> = {
  creating: "not confirmed",
  pending: "left to attach",
};

/** The counts that matter for a run's kind, in the order they are read. */
function formatCounts(record: RunRecord): string {
  const counts = record.counts;
  const order =
    record.kind === "export"
      ? (["exported", "skipped"] as const)
      : record.kind === "undo"
        ? (["deleted", "failed"] as const)
        : (["created", "pending", "creating", "failed", "skipped"] as const);
  const parts = order
    .filter((status) => (counts[status] ?? 0) > 0 || status === order[0])
    .map((status) => `${counts[status] ?? 0} ${COUNT_LABELS[status] ?? status}`);
  return parts.join(", ");
}

function fileLabel(record: RunRecord): string {
  if (!record.file) return "";
  const relative = path.relative(process.cwd(), record.file.path);
  return relative.startsWith("..") ? record.file.path : relative;
}

function pad(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, column) =>
    Math.max(...rows.map((row) => Bun.stringWidth(row[column] ?? ""))),
  );
  return rows.map((row) =>
    row
      .map((cell, column) =>
        column === row.length - 1
          ? cell
          : cell + " ".repeat(widths[column]! - Bun.stringWidth(cell)),
      )
      .join("  ")
      .trimEnd(),
  );
}

/** Error messages grouped the way the import summary groups them. */
function errorBreakdown(lines: UserLine[]): { error: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const line of lines) {
    if ((line.status === "failed" || line.status === "creating") && line.error) {
      tallyError(counts, line.error);
    }
  }
  return [...counts].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count);
}

/**
 * The import that continues this run: its file (or export run) and source,
 * with the flags that reach the same runs folder and instance.
 */
function continueCommand(record: RunRecord, carry: string[]): string | undefined {
  const input = record.fromExport ?? record.file?.path;
  if (!input) return undefined;
  const parts = ["clerk migrate import", quoteArg(input)];
  if (!record.fromExport && record.source) parts.push("--source", quoteArg(record.source));
  return withFlags(parts.join(" "), [...importFlags(record.flags ?? {}), ...carry]);
}

/**
 * Whether importing the record's file again continues this run, rather than
 * starting another or refusing: no newer import of that file and source may
 * be for the same instance, the file is unchanged, and no undo of it exists.
 * An unfinished undo makes an import refuse; a finished one that never marked
 * the run makes it start a new one.
 */
function continuesThisRun(runsDir: string, record: RunRecord): boolean {
  const file = record.file;
  if (!file) return false;
  const runs = listRuns(runsDir);
  // An import also takes a run recorded under its key's stand-in ID. Without
  // the key, a stand-in on either side may be the same instance: offering the
  // continue then could send the user to a newer run instead.
  const mayBeSameInstance = (id: string | undefined) =>
    id === record.target.instanceId ||
    isStandInInstanceId(id) ||
    isStandInInstanceId(record.target.instanceId);
  const newest = importsOfFile(runs, { sha256: file.sha256, source: record.source }).find((other) =>
    mayBeSameInstance(other.target.instanceId),
  );
  if (newest?.id !== record.id) return false;
  if (undosOf(runs, record.id).length > 0) return false;
  try {
    return sha256File(file.path) === file.sha256;
  } catch (error) {
    log.debug(`migrate: could not read ${file.path} to check it is unchanged: ${String(error)}`);
    return false;
  }
}

/**
 * What to run after reading about this run. `carry` is the runs folder this
 * listing read, and the target flags the record says the import used.
 */
function nextCommands(
  runsDir: string,
  record: RunRecord,
  state: RunState,
  carry: string[],
): string[] {
  if (state === "running") return [];
  if (record.kind === "import" && state !== "undone") {
    const undo = `Run \`${undoCommand(record.id, carry)}\` to delete the users it created`;
    const again = continueCommand(record, carry);
    const finishes = state === "interrupted" || continueFinishes(runsDir, record);
    if (!again || state === "complete" || !finishes || !continuesThisRun(runsDir, record)) {
      return [undo];
    }
    // Continuing is what a stopped run is for: the same file, source and
    // target pick it up where it left off.
    const why = state === "interrupted" ? "continue it" : "retry the users it didn't finish";
    return [`Run \`${again}\` to ${why}`, undo];
  }
  if (record.kind === "undo" && state !== "complete" && record.undoes) {
    return [`Run \`${undoCommand(record.undoes, carry)}\` to retry the users that failed`];
  }
  return [];
}

function listJson(runsDir: string, records: RunRecord[]) {
  return {
    runsDir,
    runs: records.map((record) => ({ ...record, state: runState(runsDir, record) })),
  };
}

function printList(runsDir: string, records: RunRecord[]): void {
  log.info(`Runs folder: ${runsDir}`);
  log.blank();

  if (records.length === 0) {
    log.info("No migration runs yet.");
    return;
  }

  const rows = [
    ["RUN", "DATE", "KIND", "STATUS", "TARGET", "FILE", "RESULT"].map((header) => bold(header)),
    ...records.map((record) => [
      record.id,
      formatDate(record.startedAt),
      record.kind,
      colorState(runState(runsDir, record)),
      describeTarget(record.target),
      fileLabel(record),
      formatCounts(record),
    ]),
  ];
  for (const line of pad(rows)) log.info(line);
  log.blank();
  log.info(dim(plural(records.length, "run")));
}

/** One run in full: `--json` prints it, and `printRun` renders it. */
function showJson(runsDir: string, record: RunRecord, carry: string[]) {
  const lines = [...latestUserLines(runsDir, record.id).values()];
  const state = runState(runsDir, record);
  return {
    runsDir,
    run: { ...record, state },
    next: nextCommands(runsDir, record, state, carry),
    errors: errorBreakdown(lines),
    failed: lines.filter((line) => line.status === "failed"),
    skipped: lines.filter((line) => line.status === "skipped"),
    unconfirmed: lines.filter((line) => line.status === "creating"),
  };
}

function printUsers(title: string, lines: UserLine[], usersFile: string): void {
  if (lines.length === 0) return;
  log.blank();
  log.info(bold(`${title} (${lines.length})`));
  for (const line of lines.slice(0, USER_LIST_LIMIT)) {
    const why = line.reason ?? line.error ?? "";
    log.info(`  ${line.sourceId}${why ? dim(`  ${why}`) : ""}`);
  }
  if (lines.length > USER_LIST_LIMIT) {
    log.info(dim(`  …and ${lines.length - USER_LIST_LIMIT} more in ${usersFile}`));
  }
}

function printRun(runsDir: string, record: RunRecord, carry: string[]): void {
  const view = showJson(runsDir, record, carry);
  const usersFile = path.join(runDir(runsDir, record.id), USERS_FILE);

  log.info(`Runs folder: ${runsDir}`);
  log.blank();
  const header: [string, string | undefined][] = [
    ["Run", record.id],
    ["Kind", record.kind],
    ["Status", colorState(view.run.state)],
    ["Started", formatDate(record.startedAt)],
    ["Finished", record.finishedAt ? formatDate(record.finishedAt) : undefined],
    ["Target", describeTarget(record.target)],
    ["Key from", record.target.keySource],
    ["Source", record.source],
    ["File", record.file?.path],
    ["From export", record.fromExport],
    ["Undoes", record.undoes],
    ["Undone by", record.undoneBy],
    ["Result", formatCounts(record)],
  ];
  const shown = header.filter((entry): entry is [string, string] => Boolean(entry[1]));
  const width = Math.max(...shown.map(([label]) => label.length)) + 2;
  for (const [label, value] of shown) log.info(`${bold(label.padEnd(width))}${value}`);

  if (view.errors.length > 0) {
    log.blank();
    log.info(bold("Error breakdown"));
    for (const { error, count } of view.errors) {
      log.info(`  ${red(String(count))} ${count === 1 ? "user" : "users"}: ${error}`);
    }
  }

  printUsers("Failed", view.failed, usersFile);
  printUsers(
    "Not confirmed (Clerk may have created them; a continue checks)",
    view.unconfirmed,
    usersFile,
  );
  printUsers("Skipped", view.skipped, usersFile);

  log.blank();
  log.info(dim(`Every outcome: ${usersFile}`));
  for (const step of view.next) log.info(`  → ${step}`);
}

export async function runs(id: string | undefined, options: RunsOptions = {}): Promise<void> {
  const runsDir = await resolveRunsDir(options.runsDir);

  if (id === undefined) {
    const records = listRuns(runsDir).map((record) => withLiveCounts(runsDir, record));
    if (options.json) log.data(JSON.stringify(listJson(runsDir, records), null, 2));
    else printList(runsDir, records);
    return;
  }

  const stored = readRun(runsDir, id);
  if (!stored) throwUsageError(noRunMessage(runsDir, id, carryFlags({ runsDir: options.runsDir })));
  const record = withLiveCounts(runsDir, stored);

  // The record says where the import's key came from, and so which flags
  // reach that instance again.
  const carry = laterCarry(options.runsDir, record.target);
  if (options.json) log.data(JSON.stringify(showJson(runsDir, record, carry), null, 2));
  else printRun(runsDir, record, carry);
}
