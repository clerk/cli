/**
 * Shared types for `clerk migrate`.
 *
 * Ported from the standalone migration-tool's `src/types.ts`. The Clerk API
 * error shape is declared locally rather than imported from `@clerk/types`,
 * because this command family talks to BAPI through `lib/bapi.ts` instead of
 * `@clerk/backend`.
 */

import type * as z from "zod";
import type { userSchema } from "./validator.ts";

/**
 * Password hashing algorithms Clerk can verify on import.
 *
 * When migrating users with existing passwords, the source platform's hasher
 * must be named so Clerk can validate the digest instead of rejecting it.
 */
export const PASSWORD_HASHERS = [
  "argon2i",
  "argon2id",
  "awscognito",
  "bcrypt",
  "bcrypt_peppered",
  "bcrypt_sha256_django",
  "hmac_sha256_utf16_b64",
  "md5",
  "md5_salted",
  "pbkdf2_sha1",
  "pbkdf2_sha256",
  "pbkdf2_sha256_django",
  "pbkdf2_sha512",
  "pbkdf2_sha512_hex",
  "scrypt_firebase",
  "scrypt_werkzeug",
  "sha256",
  "sha256_salted",
  "md5_phpass",
  "ldap_ssha",
  "sha512_symfony",
] as const;

/** A user that has passed schema validation and is ready to import. */
export type User = z.infer<typeof userSchema>;

/** Union of all registered transformer keys (e.g. `"clerk"`). */
export type TransformerKey = string;

/**
 * One error entry as returned in a Clerk API error response body.
 *
 * Local mirror of `@clerk/types`' `ClerkAPIError` covering only the fields the
 * migration logs read.
 */
export type ClerkApiError = {
  code: string;
  message: string;
  longMessage?: string;
};

/** A failed user-creation attempt, as handed to the error logger. */
export type ErrorPayload = {
  userId: string;
  status: string;
  errors: ClerkApiError[];
};

/** A user that failed schema validation before any API call was made. */
export type ValidationErrorPayload = {
  error: string;
  path: (string | number)[];
  userId: string;
  row: number;
};

/** A formatted error line as written to the NDJSON log. */
export type ErrorLog = {
  type: string;
  userId: string;
  status: string;
  error: string | undefined;
};

/** One import attempt as written to the NDJSON log. */
export type ImportLogEntry = {
  userId: string;
  status: "success" | "error";
  clerkUserId?: string;
  error?: string;
  code?: string;
};

/** One exported user as written to the NDJSON log. */
export type ExportLogEntry = {
  /** The source platform's ID for this user. */
  userId: string;
  status: "success" | "error";
  error?: string;
};

/** One deletion attempt as written to the NDJSON log. */
export type DeleteLogEntry = {
  /** The source platform's ID — the Clerk user's `external_id`. */
  userId: string;
  clerkUserId?: string;
  status: "success" | "error";
  error?: string;
  code?: string;
};

/** Totals for a completed import run. */
export type ImportSummary = {
  totalProcessed: number;
  successful: number;
  failed: number;
  validationFailed: number;
  errorBreakdown: Map<string, number>;
};

/**
 * Per-directory migration state, persisted to a cwd-relative `.settings` file.
 *
 * Deliberately not routed through `~/.config/clerk/config.json`: that file is
 * keyed by linked-project identity, which is a different concept from "which
 * file did I last migrate with".
 */
export type Settings = {
  key?: string;
  file?: string;
  skipUnsupportedProviders?: boolean;
  firebaseHashConfig?: FirebaseHashConfig;
};

/**
 * Firebase's scrypt parameters, needed to rebuild a password hash Clerk can
 * verify.
 *
 * Found in the Firebase console under Authentication → Users → (⋮) → Password
 * hash parameters. All four are required together; a partial set produces a
 * digest that silently fails every sign-in.
 */
export type FirebaseHashConfig = {
  base64_signer_key: string;
  base64_salt_separator: string;
  rounds: number;
  mem_cost: number;
};

/**
 * Per-run values a transformer may need but cannot read from the user record.
 *
 * Passed to `postTransform` rather than held in module state so two runs in one
 * process — or two test files — cannot see each other's configuration.
 */
export type TransformContext = {
  firebaseHashConfig?: FirebaseHashConfig;
};

/**
 * Result of a transformer's `preTransform` hook.
 *
 * @property filePath - Path to read from; may differ from the input (e.g. a
 *   temp file with generated CSV headers).
 * @property data - Users already extracted from a wrapper object, when the
 *   source format nests them.
 */
export type PreTransformResult = {
  filePath: string;
  data?: Record<string, unknown>[];
};

/**
 * A platform transformer: how to get from one source export shape to Clerk's
 * import shape.
 *
 * @property transformer - Source field path → Clerk field name.
 * @property defaults - Values merged into every user from this platform.
 * @property preTransform - Runs before field mapping.
 * @property postTransform - Mutates a user after field mapping, given the
 *   run's {@link TransformContext}.
 */
export type TransformerRegistryEntry = {
  key: string;
  label: string;
  description: string;
  transformer: Record<string, string>;
  defaults?: Record<string, unknown>;
  preTransform?: (
    filePath: string,
    fileType: string,
  ) => PreTransformResult | Promise<PreTransformResult>;
  postTransform?: (user: Record<string, unknown>, context: TransformContext) => void;
};
