/**
 * Reading an export file the way an import does.
 */

import fs from "node:fs";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";

/**
 * A JSON file's contents, as an import reads it.
 *
 * A UTF-8 BOM (Excel's "CSV UTF-8", some editors) is stripped. NDJSON, one
 * object per line, reads as an array: it is what Auth0's bulk export job
 * writes. `.ndjson` and `.jsonl` are always read that way; a `.json` file
 * falls back to it only when it doesn't parse whole.
 *
 * @throws CliError naming the file when it is neither.
 */
export function readJsonFile(file: string): unknown {
  const text = fs.readFileSync(file, "utf-8").replace(/^\uFEFF/, "");
  const lines = () => text.split("\n").filter((line) => line.trim());
  const invalid = (error: unknown) =>
    new CliError(`${file} is not valid JSON: ${(error as Error).message}`, {
      code: ERROR_CODE.INVALID_JSON,
    });

  if (/\.(ndjson|jsonl)$/i.test(file)) {
    try {
      return lines().map((line) => JSON.parse(line) as unknown);
    } catch (error) {
      throw invalid(error);
    }
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    try {
      if (lines().length > 1) return lines().map((line) => JSON.parse(line) as unknown);
    } catch {
      // Not NDJSON either: report the whole-file error, which names the spot.
    }
    throw invalid(error);
  }
}
