/**
 * `clerk migrate logs convert` — NDJSON to a JSON array.
 *
 * Ported from the standalone migration-tool's `src/convert-logs/index.ts`,
 * with two changes: files can be named as positionals or `--all` instead of
 * only through a picker, and a malformed line is reported with its line number
 * rather than aborting the whole file.
 */

import fs from "node:fs";
import { CliError, ERROR_CODE, throwUsageError, throwUserAbort } from "../../../lib/errors.ts";
import { dim } from "../../../lib/color.ts";
import { log } from "../../../lib/log.ts";
import { multiselect } from "../../../lib/prompts.ts";
import { withGutter } from "../../../lib/spinner.ts";
import { isAgent, isHuman } from "../../../mode.ts";
import { findLogFile, listLogFiles, readNdjson, type LogFile } from "../lib/log-files.ts";
import { getLogDir, resolveLogDir } from "../lib/logger.ts";

export type LogsConvertOptions = {
  all?: boolean;
  files?: string[];
};

/** The `.json` sibling a log converts into. */
export function outputPathFor(file: LogFile): string {
  return file.path.replace(/\.log$/, ".json");
}

/**
 * Resolves which files to convert: explicit positionals, `--all`, or a
 * multiselect when a human gave neither.
 */
async function resolveTargets(options: LogsConvertOptions): Promise<LogFile[]> {
  const available = listLogFiles();

  if (available.length === 0) {
    log.info(`No migration logs to convert in ${getLogDir()}.`);
    return [];
  }

  if (options.files && options.files.length > 0) {
    return options.files.map((name) => {
      const found = findLogFile(name);
      if (!found) {
        throw new CliError(`No log file named ${name} in ${getLogDir()}.`, {
          code: ERROR_CODE.FILE_NOT_FOUND,
        });
      }
      return found;
    });
  }

  if (options.all) return available;

  if (isAgent() || !isHuman()) {
    throwUsageError(
      "`clerk migrate logs convert` needs a file to convert and cannot prompt here. Name one or more log files, or pass --all.",
      undefined,
      undefined,
      [
        { command: "clerk migrate logs convert --all", description: "Convert every log file" },
        {
          command: `clerk migrate logs convert ${available[0]?.name ?? "migration-....log"}`,
          description: "Convert one log file",
        },
      ],
    );
  }

  const chosen = await multiselect<string>({
    message: "Which log files should be converted to JSON?",
    options: available.map((file) => ({
      value: file.name,
      label: file.name,
      hint: `${file.entryCount} entries`,
    })),
  });
  if (chosen.length === 0) throwUserAbort();

  return available.filter((file) => chosen.includes(file.name));
}

export async function convert(options: LogsConvertOptions = {}): Promise<void> {
  // The multiselect lives inside the gutter so cancelling it closes with
  // `└ Paused` rather than leaving a half-drawn frame.
  await withGutter("Converting migration logs", async () => {
    await resolveLogDir();
    const targets = await resolveTargets(options);
    if (targets.length === 0) return;

    let converted = 0;
    let malformed = 0;

    for (const file of targets) {
      const output = outputPathFor(file);

      try {
        const { entries, errors } = readNdjson(file.path);

        // Reported per line, so a truncated final line from an interrupted run
        // is visible rather than silently missing from the output.
        for (const error of errors) {
          malformed++;
          log.warn(
            `${file.name}:${error.line} is not valid JSON and was skipped — ${error.message}`,
          );
        }

        fs.writeFileSync(output, JSON.stringify(entries, null, 2));
        converted++;
        const count = `${entries.length} ${entries.length === 1 ? "entry" : "entries"}`;
        log.info(`${file.name} → ${output.split("/").pop()} ${dim(`(${count})`)}`);
      } catch (error) {
        log.warn(`Could not convert ${file.name}: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    }

    if (converted > 0) {
      log.success(
        `Converted ${converted} log file${converted === 1 ? "" : "s"}. Originals left in place.`,
      );
    }
    if (malformed > 0) {
      log.warn(`${malformed} malformed line${malformed === 1 ? "" : "s"} skipped.`);
    }
  });
}
