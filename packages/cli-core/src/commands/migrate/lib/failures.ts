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
  return {
    message: apiError.longMessage ?? apiError.message ?? "Unknown error",
    code: String(apiError.status ?? "unknown"),
  };
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
