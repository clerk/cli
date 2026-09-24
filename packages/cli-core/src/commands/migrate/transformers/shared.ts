/**
 * Helpers shared by more than one transformer.
 *
 * Every source platform records verification as a sibling field of the
 * identifier, and several ship a single `name` string where Clerk wants a
 * first/last pair — so both live here rather than being copied five times.
 */

/**
 * How a platform records that an identifier is verified.
 *
 * - `boolean` — a true/false flag (Auth0, Better Auth, Firebase). A CSV export
 *   turns these into the *strings* `"true"`/`"false"`, so `"false"` must not
 *   be mistaken for a truthy value.
 * - `timestamp` — a nullable confirmation time (Auth.js `email_verified`,
 *   Supabase `email_confirmed_at`). Any real value means verified.
 */
export type VerificationStyle = "boolean" | "timestamp";

/** CSV exports write SQL NULL as one of these rather than an empty cell. */
const NULLISH_STRINGS = new Set(["", "null", "nil", "undefined", "\\n"]);

export function isVerified(value: unknown, style: VerificationStyle): boolean {
  if (value === null || value === undefined) return false;

  if (style === "boolean") {
    return value === true || value === 1 || value === "true" || value === "1";
  }

  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "number") return true;
  return typeof value === "string" && !NULLISH_STRINGS.has(value.trim().toLowerCase());
}

/**
 * Routes an identifier to its verified or unverified field, then drops the
 * platform's verification marker.
 *
 * An unverified identifier must not go on `POST /v1/users`'s primary field:
 * Clerk creates those verified, which would silently promote an address the
 * source platform never confirmed.
 */
export function routeByVerification(
  user: Record<string, unknown>,
  field: "email" | "phone",
  verifiedField: string,
  style: VerificationStyle,
): void {
  const value = user[field];
  if (value && !isVerified(user[verifiedField], style)) {
    user[field === "email" ? "unverifiedEmailAddresses" : "unverifiedPhoneNumbers"] = value;
    delete user[field];
  }
  delete user[verifiedField];
}

/**
 * Splits a single display name into `firstName` and `lastName`.
 *
 * Only splits when there are at least two words — a one-word name would
 * otherwise produce a first name with no last name, which several instance
 * configurations reject.
 */
export function splitName(user: Record<string, unknown>, field = "name"): void {
  const name = user[field];
  if (!name || typeof name !== "string") return;

  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) {
    user.firstName = parts[0];
    user.lastName = parts.slice(1).join(" ");
  }
  delete user[field];
}

/**
 * Converts a source timestamp to ISO 8601, leaving it untouched when it does
 * not parse so the schema reports it as a validation failure with the original
 * value visible in the log.
 *
 * @param epochMillis - Treat a bare number (or numeric string) as Unix
 *   milliseconds, which is how Firebase exports timestamps.
 */
export function toIsoDate(value: unknown, epochMillis = false): unknown {
  if (value === undefined || value === null || value === "") return value;

  const parsed =
    epochMillis && (typeof value === "number" || /^\d+$/.test(String(value)))
      ? new Date(Number(value))
      : new Date(String(value));

  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}
