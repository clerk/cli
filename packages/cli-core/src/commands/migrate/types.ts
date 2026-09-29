/**
 * Shared types for `clerk migrate`.
 *
 * Ported from the standalone migration-tool's `src/types.ts`.
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

/** Totals for a completed import run. */
export type ImportSummary = {
  totalProcessed: number;
  successful: number;
  failed: number;
  validationFailed: number;
  errorBreakdown: Map<string, number>;
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
 * Per-run values a source may need but cannot read from the user record.
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

/** How much of one kind of data a source brings across. */
export type CarryLevel = "yes" | "no" | "partial";

export type Carry = { level: CarryLevel; note: string };

/**
 * What a source brings across, per kind of data that is easy to lose without
 * noticing. Social sign-ins are not listed: no source carries them, and every
 * source shares one account-linking note instead.
 */
export type SourceCarries = { passwords: Carry; mfa: Carry; metadata: Carry };

/**
 * A source: how to get from one platform's export shape to Clerk's import
 * shape.
 *
 * @property transformer - Source field path → Clerk field name.
 * @property carries - What comes across: passwords, MFA and metadata.
 * @property caveats - Anything else worth knowing before importing.
 * @property defaults - Values merged into every user from this platform.
 * @property preTransform - Runs before field mapping.
 * @property postTransform - Mutates a user after field mapping, given the
 *   run's {@link TransformContext}.
 */
export type SourceEntry = {
  key: string;
  label: string;
  description: string;
  transformer: Record<string, string>;
  carries: SourceCarries;
  caveats?: string[];
  defaults?: Record<string, unknown>;
  preTransform?: (
    filePath: string,
    fileType: string,
  ) => PreTransformResult | Promise<PreTransformResult>;
  postTransform?: (user: Record<string, unknown>, context: TransformContext) => void;
};
