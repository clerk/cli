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
    const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
    return isEnvelope(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
