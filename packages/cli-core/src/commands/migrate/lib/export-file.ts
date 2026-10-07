/**
 * The file `clerk migrate export` writes: the users, wrapped in an envelope
 * that says where they came from.
 *
 * The envelope is what lets `clerk migrate import <export-run-id>` run with no
 * `--source`: the source, and Firebase's hash parameters, travel with the
 * users. A bare array, a CSV, or Firebase's own `{ users: [...] }` still
 * import, but need the source named.
 */

import fs from "node:fs";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import type { FirebaseHashConfig } from "../types.ts";

export const ENVELOPE_VERSION = 1;

export type ExportEnvelope = {
  clerkMigrate: typeof ENVELOPE_VERSION;
  source: string;
  exportedAt: string;
  runId: string;
  firebase?: FirebaseHashConfig;
  users: Record<string, unknown>[];
};

export function isEnvelope(value: unknown): value is ExportEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Partial<ExportEnvelope>;
  return (
    candidate.clerkMigrate === ENVELOPE_VERSION &&
    typeof candidate.source === "string" &&
    Array.isArray(candidate.users)
  );
}

/**
 * The envelope in a file, when it has one.
 *
 * `undefined` for a CSV, a bare array, or anything unreadable: those are the
 * shapes that need `--source`, and the load that follows reports what is
 * actually wrong with a broken file.
 */
// ponytail: parses the file here and again when the users load; cache by path if exports get large enough to notice.
export function readEnvelope(file: string): ExportEnvelope | undefined {
  if (!file.toLowerCase().endsWith(".json")) return undefined;
  try {
    const parsed = readJsonFile(file);
    return isEnvelope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

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
