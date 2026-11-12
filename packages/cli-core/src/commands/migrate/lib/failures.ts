/**
 * How a failed request reads in a run's lines and summaries, shared by import,
 * undo, and `runs`.
 */

import type { BapiError } from "../../../lib/errors.ts";
import { RateLimitExceededError } from "./retry.ts";

/** A failed request's message and code, as a run line records them. */
export function failureOf(error: unknown): { message: string; code: string } {
  if (error instanceof RateLimitExceededError) return { message: error.message, code: "429" };
  const apiError = error as BapiError;
  const code = String(apiError.status ?? "unknown");
  const message = apiError.longMessage ?? apiError.message ?? "Unknown error";
  // A proxy's or gateway's error page, not Clerk's JSON: its markup says
  // nothing a summary could use, and fills a terminal.
  if (/^\s*<(!doctype|html|head|body)\b/i.test(message)) {
    return { message: `Clerk returned HTTP ${code} with no error details`, code };
  }
  return { message, code };
}

/** Counts a failure under its normalized message, the way every summary groups them. */
export function tallyError(breakdown: Map<string, number>, message: string): void {
  const key = normalizeErrorMessage(message);
  breakdown.set(key, (breakdown.get(key) ?? 0) + 1);
}

/**
 * Groups error messages that differ only in field ordering, so the summary
 * reports "12 users: [\"first_name\" \"last_name\"] ..." once instead of twice.
 */
export function normalizeErrorMessage(message: string): string {
  return message.replace(/\[([^\]]*)\]/g, (_, fields: string) => {
    const names = fields
      .split(/["'\s]+/)
      .filter(Boolean)
      .sort();
    return `[${names.map((name) => `"${name}"`).join(" ")}]`;
  });
}

/** How `result.warnings` and `runs <id>` word a user imported without their first phone. */
export const WITHOUT_PHONE_WARNING = "imported without their phone: ";
/** How they word a user imported without an extra email or phone Clerk refused. */
export const WITHOUT_IDENTIFIER_WARNING = "imported without an email or phone Clerk refused: ";
