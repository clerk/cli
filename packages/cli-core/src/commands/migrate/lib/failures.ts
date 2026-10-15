/**
 * How a failed request reads in a run's lines and summaries, shared by import,
 * undo and `runs`.
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
export function normalizeErrorMessage(errorMessage: string): string {
  let normalized = "";
  let lastCopiedIndex = 0;
  let arrayStartIndex = -1;

  for (let i = 0; i < errorMessage.length; i++) {
    const char = errorMessage[i];

    if (arrayStartIndex === -1) {
      if (char === "[") arrayStartIndex = i;
      continue;
    }
    if (char !== "]") continue;

    normalized += errorMessage.slice(lastCopiedIndex, arrayStartIndex);
    normalized += normalizeFieldArray(errorMessage.slice(arrayStartIndex + 1, i));
    lastCopiedIndex = i + 1;
    arrayStartIndex = -1;
  }

  return normalized + errorMessage.slice(lastCopiedIndex);
}

function normalizeFieldArray(fields: string): string {
  const fieldNames: string[] = [];
  let current = "";

  for (const char of fields) {
    if (char === '"' || char === "'" || char.trim() === "") {
      if (current.length > 0) {
        fieldNames.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) fieldNames.push(current);

  fieldNames.sort();
  return `[${fieldNames.map((name) => `"${name}"`).join(" ")}]`;
}
