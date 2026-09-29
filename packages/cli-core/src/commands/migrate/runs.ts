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
import { log } from "../../lib/log.ts";
import { normalizeErrorMessage } from "./import-users.ts";
import {
  latestUserLines,
  listRuns,
  readRun,
  resolveRunsDir,
  runDir,
  runState,
  type RunRecord,
  type RunState,
  type UserLine,
} from "./lib/run-store.ts";
import { describeTarget } from "./lib/target.ts";

export type RunsOptions = {
  json?: boolean;
  runsDir?: string;
};

/** How many failed or skipped users `runs <id>` prints before pointing at the file. */
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

/** The counts that matter for a run's kind, in the order they are read. */
export function formatCounts(record: RunRecord): string {
  const counts = record.counts;
  const order =
    record.kind === "export"
      ? (["exported", "skipped"] as const)
      : record.kind === "undo"
        ? (["deleted", "failed"] as const)
        : (["created", "failed", "skipped"] as const);
  const parts = order
    .filter((status) => (counts[status] ?? 0) > 0 || status === order[0])
    .map((status) => `${counts[status] ?? 0} ${status}`);
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
    if (line.status !== "failed" || !line.error) continue;
    const key = normalizeErrorMessage(line.error);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts].map(([error, count]) => ({ error, count })).sort((a, b) => b.count - a.count);
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
  log.info(dim(`${records.length} run${records.length === 1 ? "" : "s"}`));
}

function showJson(runsDir: string, record: RunRecord) {
  const lines = [...latestUserLines(runsDir, record.id).values()];
  return {
    runsDir,
    run: { ...record, state: runState(runsDir, record) },
    errors: errorBreakdown(lines),
    failed: lines.filter((line) => line.status === "failed"),
    skipped: lines.filter((line) => line.status === "skipped"),
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

function printRun(runsDir: string, record: RunRecord): void {
  const state = runState(runsDir, record);
  const dir = runDir(runsDir, record.id);
  const usersFile = path.join(dir, "users.ndjson");
  const lines = [...latestUserLines(runsDir, record.id).values()];

  log.info(`Runs folder: ${runsDir}`);
  log.blank();
  const header: [string, string | undefined][] = [
    ["Run", record.id],
    ["Kind", record.kind],
    ["Status", colorState(state)],
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

  const errors = errorBreakdown(lines);
  if (errors.length > 0) {
    log.blank();
    log.info(bold("Error breakdown"));
    for (const { error, count } of errors) {
      log.info(`  ${red(String(count))} ${count === 1 ? "user" : "users"}: ${error}`);
    }
  }

  printUsers(
    "Failed",
    lines.filter((line) => line.status === "failed"),
    usersFile,
  );
  printUsers(
    "Skipped",
    lines.filter((line) => line.status === "skipped"),
    usersFile,
  );

  log.blank();
  log.info(dim(`Every outcome: ${usersFile}`));
}

export async function runs(id: string | undefined, options: RunsOptions = {}): Promise<void> {
  const runsDir = await resolveRunsDir(options.runsDir);

  if (id === undefined) {
    const records = listRuns(runsDir);
    if (options.json) log.data(JSON.stringify(listJson(runsDir, records), null, 2));
    else printList(runsDir, records);
    return;
  }

  const record = readRun(runsDir, id);
  if (!record) {
    throwUsageError(`No run \`${id}\` in ${runsDir}. Run \`clerk migrate runs\` to list them.`);
  }

  if (options.json) log.data(JSON.stringify(showJson(runsDir, record), null, 2));
  else printRun(runsDir, record);
}
