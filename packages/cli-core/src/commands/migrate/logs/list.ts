/**
 * `clerk migrate logs list` — what is in `./logs/`.
 *
 * New in the CLI: the standalone tool enumerated the directory only to build
 * its own pickers. Exposing it gives a human a "what did I just do" view and
 * an agent a read-only way to inspect a migration without parsing NDJSON.
 */

import { bold, cyan, dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { withGutter } from "../../../lib/spinner.ts";
import { formatSize, listLogFiles, type LogFile, type LogKind } from "../lib/log-files.ts";
import { displayLogDir } from "../lib/logger.ts";

/** Every kind a log file can be, and what one entry in it records. */
const KIND_LEGEND: Record<Exclude<LogKind, "unknown">, string> = {
  export: "One entry per user pulled from the source platform.",
  import: "One entry per user created in Clerk, with any error.",
  delete: "One entry per user removed from Clerk, with any error.",
};

const legendWidth = Math.max(...Object.keys(KIND_LEGEND).map((kind) => kind.length)) + 2;

export type LogsListOptions = {
  json?: boolean;
};

function toJson(files: LogFile[]) {
  return files.map((file) => ({
    name: file.name,
    kind: file.kind,
    timestamp: file.timestamp,
    size_bytes: file.sizeBytes,
    entry_count: file.entryCount,
    path: file.path,
  }));
}

/**
 * The filename stamp as a date a human reads at a glance.
 *
 * The stamp is UTC (`getDateTimeStamp` is an ISO string with its colons swapped
 * for filename-legal dashes), so it is parsed as UTC and rendered in the
 * viewer's own zone — "which run was that" is a question about local time.
 * Returns the raw stamp for anything unparseable rather than printing
 * "Invalid Date".
 */
export function formatTimestamp(stamp: string): string {
  if (!stamp) return "";
  const date = new Date(`${stamp.replace(/T(\d{2})-(\d{2})-(\d{2})$/, "T$1:$2:$3")}Z`);
  if (Number.isNaN(date.getTime())) return stamp;
  return date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

export async function list(options: LogsListOptions = {}): Promise<void> {
  const files = listLogFiles();

  if (options.json) {
    log.data(JSON.stringify(toJson(files), null, 2));
    return;
  }

  await withGutter("Listing migration logs", async () => {
    if (files.length === 0) {
      log.info(`No migration logs in ${displayLogDir()}.`);
      return;
    }

    const rows = files.map((file) => ({
      name: file.name,
      kind: file.kind,
      when: formatTimestamp(file.timestamp),
      size: formatSize(file.sizeBytes),
      entries: String(file.entryCount),
    }));

    const width = (header: string, pick: (row: (typeof rows)[number]) => string) =>
      Math.max(header.length, ...rows.map((row) => pick(row).length)) + 2;

    /**
     * Pads to the visible width, then colours. Colouring first would count the
     * ANSI escape bytes towards the width and pull every later column left.
     */
    const column = (text: string, size: number, paint: (value: string) => string) =>
      paint(text) + " ".repeat(Math.max(0, size - text.length));

    const nameWidth = width("FILE", (row) => row.name);
    const kindWidth = width("TYPE", (row) => row.kind);
    const whenWidth = width("DATE", (row) => row.when);
    const sizeWidth = width("SIZE", (row) => row.size);

    log.info("Each log represents a user export, user import, or a user delete run.");
    log.info("Each log consists of a single NDJSON entry per user.");
    log.blank();

    log.info(
      dim("FILE".padEnd(nameWidth)) +
        dim("TYPE".padEnd(kindWidth)) +
        dim("DATE".padEnd(whenWidth)) +
        dim("SIZE".padEnd(sizeWidth)) +
        dim("ENTRIES"),
    );

    for (const row of rows) {
      log.info(
        column(row.name, nameWidth, cyan) +
          row.kind.padEnd(kindWidth) +
          column(row.when || "—", whenWidth, row.when ? (value) => value : dim) +
          column(row.size, sizeWidth, dim) +
          row.entries,
      );
    }

    log.blank();
    log.info(`${files.length} log file${files.length === 1 ? "" : "s"} in ${displayLogDir()}`);
    log.blank();

    // A listing only shows the kinds that happen to be present, so the legend
    // is fixed: it also answers "what else could be here".
    log.info(bold("Log types:"));
    for (const [kind, description] of Object.entries(KIND_LEGEND)) {
      log.info(`  ${cyan(bold(kind))}${" ".repeat(legendWidth - kind.length)}${description}`);
    }
  });
}
