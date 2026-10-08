/**
 * Firebase's four scrypt parameters, read from the `--firebase-*` flags.
 *
 * **Only read when the source is `firebase`.** `migrate import` is one
 * command serving every platform, and nothing but the Firebase source
 * reads the config off {@link TransformContext}.
 */

import { throwUsageError } from "../../../lib/errors.ts";
import type { FirebaseHashConfig } from "../types.ts";

/** The `--firebase-*` flags, keyed by their option name. */
export const FIREBASE_FLAGS = [
  ["firebaseSignerKey", "--firebase-signer-key"],
  ["firebaseSaltSeparator", "--firebase-salt-separator"],
  ["firebaseRounds", "--firebase-rounds"],
  ["firebaseMemCost", "--firebase-mem-cost"],
] as const;

export type FirebaseHashFlags = {
  firebaseSignerKey?: string;
  firebaseSaltSeparator?: string;
  firebaseRounds?: number;
  firebaseMemCost?: number;
};

/**
 * Resolves the four parameters from the flags.
 *
 * The four are required as a set: a digest built from a partial set is
 * well-formed but verifies against nothing, so every migrated user would fail
 * to sign in with no error at import time.
 *
 * @param source - The platform being migrated. Anything but `firebase`
 *   returns immediately.
 * @returns The config, or `undefined` when none was supplied — which is fine
 *   for an export that carries no password hashes.
 */
export function resolveFirebaseHashConfig(
  flags: FirebaseHashFlags,
  source: string | undefined,
): FirebaseHashConfig | undefined {
  if (source !== "firebase") return undefined;

  const provided = FIREBASE_FLAGS.filter(([key]) => flags[key] !== undefined);
  if (provided.length === 0) return undefined;

  if (provided.length < FIREBASE_FLAGS.length) {
    const missing = FIREBASE_FLAGS.filter(([key]) => flags[key] === undefined).map(
      ([, flag]) => flag,
    );
    throwUsageError(
      `The Firebase hash parameters must be supplied together. Missing: ${missing.join(", ")}.\n` +
        "Find all four in the Firebase console under Authentication → Users → (⋮) → Password hash parameters.",
      "https://clerk.com/docs/guides/development/migrating/firebase",
    );
  }

  return {
    base64_signer_key: flags.firebaseSignerKey as string,
    base64_salt_separator: flags.firebaseSaltSeparator as string,
    rounds: flags.firebaseRounds as number,
    mem_cost: flags.firebaseMemCost as number,
  };
}

/** Clerk's bounds on Firebase scrypt costs (clerk_go `pkg/hash/scrypt.go`). */
const MAX_SCRYPT_COST = 16;

/** One whole base64 string: full groups of four, padded only at the end. */
const STRICT_BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/**
 * True when Clerk can decode it: it maps the URL-safe alphabet onto the
 * standard one and pads to a multiple of four (`normalizeBase64` in clerk_go
 * `pkg/hash/scrypt.go`), then decodes strictly. So `Bw` passes and `A` or
 * `AAAA=` do not.
 */
function decodesLikeClerk(value: string): boolean {
  let normalized = value.replace(/-/g, "+").replace(/_/g, "/");
  const rem = normalized.length % 4;
  if (rem !== 0) normalized += "=".repeat(4 - rem);
  return normalized.length > 0 && STRICT_BASE64.test(normalized);
}

/**
 * What is wrong with a set of Firebase hash parameters, or `undefined`.
 *
 * Each one goes into every `scrypt_firebase` digest, so a bad one costs every
 * password in the import: Clerk refuses a cost outside 1..16 and a key that is
 * not base64, and a `$` would break the digest's segments.
 */
export function firebaseHashConfigProblem(config: FirebaseHashConfig): string | undefined {
  const keys = [
    ["signer key", config.base64_signer_key],
    ["salt separator", config.base64_salt_separator],
  ] as const;
  for (const [label, value] of keys) {
    if (typeof value !== "string" || !decodesLikeClerk(value)) return `the ${label} is not base64`;
  }
  const costs = [
    ["rounds", config.rounds],
    ["memory cost", config.mem_cost],
  ] as const;
  for (const [label, value] of costs) {
    if (!Number.isInteger(value) || value < 1 || value > MAX_SCRYPT_COST) {
      return `${label} must be a whole number from 1 to ${MAX_SCRYPT_COST}, not ${String(value)}`;
    }
  }
  return undefined;
}
