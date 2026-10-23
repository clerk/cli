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

/**
 * True for a string a CSV export writes in place of SQL NULL. A first name
 * that really is "Null" reads as one too; the spellings tools write matter more.
 */
export function isNullish(value: unknown): boolean {
  return typeof value === "string" && NULLISH_STRINGS.has(value.trim().toLowerCase());
}

/**
 * A boolean as a CSV or a database writes it: `TRUE` from a spreadsheet, `t`
 * and `f` from psql, `yes`/`no`. Anything else is returned unchanged, so the
 * schema can reject it.
 */
export function normalizeBooleanField(value: unknown): unknown {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return value;
  }
  if (typeof value !== "string") return value;

  const normalized = value.trim().toLowerCase();
  if (["true", "1", "yes", "y", "t"].includes(normalized)) return true;
  if (["false", "0", "no", "n", "f"].includes(normalized)) return false;
  return value;
}

export function isVerified(value: unknown, style: VerificationStyle): boolean {
  if (value === null || value === undefined) return false;

  if (style === "boolean") return normalizeBooleanField(value) === true;

  if (value instanceof Date) return !Number.isNaN(value.getTime());
  if (typeof value === "number") return true;
  return typeof value === "string" && !isNullish(value);
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

/** The user's email addresses, wherever the source routed them. */
function emailsOf(user: Record<string, unknown>): Set<string> {
  const emails = new Set<string>();
  for (const field of ["email", "emailAddresses", "unverifiedEmailAddresses"]) {
    const value = user[field];
    for (const email of Array.isArray(value) ? value : [value]) {
      if (typeof email === "string") emails.add(email.trim().toLowerCase());
    }
  }
  return emails;
}

/**
 * Splits a single display name into `firstName` and `lastName`: the first word,
 * then the rest. A one-word name (`Cher`) becomes the first name alone.
 *
 * A one-word value that is one of the user's own email addresses is dropped
 * instead: Auth0 fills `name` with the email for database users, and that is
 * not anyone's name. Any other name with an `@` in it is kept.
 */
export function splitName(user: Record<string, unknown>, field = "name"): void {
  const name = user[field];
  if (!name || typeof name !== "string") return;

  const parts = name.trim().split(/\s+/);
  if (parts.length > 1) {
    user.firstName = parts[0];
    user.lastName = parts.slice(1).join(" ");
  } else if (parts[0] && !emailsOf(user).has(parts[0].toLowerCase())) {
    user.firstName = parts[0];
  }
  delete user[field];
}

/**
 * Parses a date string as `Date` does, but reads a date and time with no
 * offset (`2024-08-24 03:40:02`, as SQL and CSV exports write them) as UTC
 * rather than the machine's local time, so an import means the same on any
 * clock.
 */
export function parseDate(value: string): Date {
  const trimmed = value.trim();
  return /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(trimmed)
    ? new Date(`${trimmed.replace(" ", "T")}Z`)
    : new Date(trimmed);
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
      : parseDate(String(value));

  return Number.isNaN(parsed.getTime()) ? value : parsed.toISOString();
}

/**
 * The hasher for a self-describing bcrypt or argon2 digest, or undefined.
 * Platforms that accept imported hashes (Supabase, Better Auth) can hold
 * either, so the hasher is read per user rather than assumed per source.
 */
/**
 * The argon2 variant of a digest Clerk can decode, or undefined.
 *
 * Mirrors clerk_go's `argon2.DecodeHash`: `$argon2id$v=19$m=…,t=…,p=…$salt$key`,
 * salt and key in unpadded standard base64 that re-encodes to itself, and the
 * costs Clerk caps on import (1 GiB of memory, 20 passes, 16 lanes). A zero
 * cost decodes, but argon2 cannot run with it.
 */
export function argon2Variant(hash: string): "argon2id" | "argon2i" | undefined {
  const match =
    /^\$(argon2id|argon2i)\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(
      hash,
    );
  if (!match) return undefined;
  const [, variant, memory, passes, lanes, salt, key] = match;
  const within = (value: string | undefined, max: number) =>
    Number(value) >= 1 && Number(value) <= max;
  const canonical = (value: string | undefined) =>
    !!value && Buffer.from(value, "base64").toString("base64").replace(/=+$/, "") === value;
  return within(memory, 1 << 20) &&
    within(passes, 20) &&
    within(lanes, 16) &&
    canonical(salt) &&
    canonical(key)
    ? (variant as "argon2id" | "argon2i")
    : undefined;
}

export function detectStandardHasher(hash: string): "bcrypt" | "argon2id" | "argon2i" | undefined {
  // The whole digest, not the prefix: a malformed one is dropped like any
  // other unusable hash, where a prefix match would see the user rejected.
  // clerk_go caps the cost at 15 (pkg/hash/bcrypt.go), and Go's bcrypt
  // refuses any cost under 4 at sign-in, so such a digest could never be used.
  if (/^\$2[aby]\$(0[4-9]|1[0-5])\$[./A-Za-z0-9]{53}$/.test(hash)) return "bcrypt";
  return argon2Variant(hash);
}
