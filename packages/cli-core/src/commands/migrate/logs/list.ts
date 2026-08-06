/**
 * `clerk migrate logs list` — what is in `./logs/`.
 *
 * New in the CLI: the standalone tool enumerated the directory only to build
 * its own pickers. Exposing it gives a human a "what did I just do" view and
 * an agent a read-only way to inspect a migration without parsing NDJSON.
 */

import { cyan, dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { formatSize, listLogFiles, type LogFile } from "../lib/log-files.ts";
import { getLogDir } from "../lib/logger.ts";

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

export function list(options: LogsListOptions = {}): void {
  const files = listLogFiles();

  if (options.json) {
    log.data(JSON.stringify(toJson(files), null, 2));
    return;
  }

  if (files.length === 0) {
    log.info(`No migration logs in ${getLogDir()}.`);
    return;
  }

  const kindWidth = Math.max(...files.map((file) => file.kind.length), "TYPE".length) + 2;
  const timeWidth = Math.max(...files.map((file) => file.timestamp.length), "TIMESTAMP".length) + 2;
  const sizeWidth = Math.max(...files.map((file) => formatSize(file.sizeBytes).length), 4) + 2;

  log.info(
    dim("TYPE".padEnd(kindWidth)) +
      dim("TIMESTAMP".padEnd(timeWidth)) +
      dim("SIZE".padEnd(sizeWidth)) +
      dim("ENTRIES"),
  );

  for (const file of files) {
    log.info(
      cyan(file.kind.padEnd(kindWidth)) +
        (file.timestamp || dim("—")).padEnd(timeWidth) +
        dim(formatSize(file.sizeBytes).padEnd(sizeWidth)) +
        String(file.entryCount),
    );
  }

  log.info("");
  log.info(dim(`${files.length} log file${files.length === 1 ? "" : "s"} in ${getLogDir()}`));
}
