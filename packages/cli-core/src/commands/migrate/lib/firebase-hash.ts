/**
 * Firebase's four scrypt parameters, read from the `--firebase-*` flags.
 *
 * **Only read when the transformer is `firebase`.** `migrate import` is one
 * command serving every platform, and nothing but the Firebase transformer
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
 * @param transformer - The platform being migrated. Anything but `firebase`
 *   returns immediately.
 * @returns The config, or `undefined` when none was supplied — which is fine
 *   for an export that carries no password hashes.
 */
export function resolveFirebaseHashConfig(
  flags: FirebaseHashFlags,
  transformer: string | undefined,
): FirebaseHashConfig | undefined {
  if (transformer !== "firebase") return undefined;

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
