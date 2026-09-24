/**
 * Firebase's four scrypt parameters: where they come from, and when they are
 * looked for at all.
 *
 * **Only read when the transformer is `firebase`.** `migrate import` is one
 * command serving every platform, so a `CLERK_FIREBASE_SIGNER_KEY` left in
 * `.env.clerk-migrate` after a Firebase migration is in scope for the Supabase
 * run that follows it unless something says otherwise. Nothing downstream would
 * misuse it — only the Firebase transformer reads the config off
 * {@link TransformContext} — but resolving it means a stale or partial set can
 * warn, or fail, a run that never mentioned Firebase. So the gate is here,
 * before the lookup, rather than a filter after it.
 *
 * The per-platform export commands need no such gate: `migrate export auth0`
 * reads `AUTH0_*` and nothing else, because the command itself is the platform.
 * This is the only place one command spans them all.
 */

import { throwUsageError } from "../../../lib/errors.ts";
import { log } from "../../../lib/log.ts";
import { envNames, findSetting } from "../settings/registry.ts";
import { findMigrateEnvValue } from "./env-file.ts";
import type { FirebaseHashConfig } from "../types.ts";

/** The `--firebase-*` flags, and the setting each falls back to. */
export const FIREBASE_FLAGS = [
  ["firebaseSignerKey", "--firebase-signer-key", "firebase-signer-key"],
  ["firebaseSaltSeparator", "--firebase-salt-separator", "firebase-salt-separator"],
  ["firebaseRounds", "--firebase-rounds", "firebase-rounds"],
  ["firebaseMemCost", "--firebase-mem-cost", "firebase-mem-cost"],
] as const;

const FIREBASE_NUMERIC: ReadonlySet<string> = new Set(["firebaseRounds", "firebaseMemCost"]);

export type FirebaseHashFlags = {
  firebaseSignerKey?: string;
  firebaseSaltSeparator?: string;
  firebaseRounds?: number;
  firebaseMemCost?: number;
};

/**
 * Overlays the saved environment values onto whichever flags were not passed.
 *
 * The variables come from the settings registry — `CLERK_FIREBASE_*` and the
 * unprefixed names Firebase itself uses — so `clerk migrate settings` and the
 * import read exactly the same set. Resolved through
 * {@link findMigrateEnvValue}: the environment first, then
 * `.env.clerk-migrate`, then the app's own `.env` files. The signer key is a
 * Firebase secret, so it is never written to the CLI's config —
 * `.env.clerk-migrate` is gitignored on creation.
 */
async function withFirebaseEnv(flags: FirebaseHashFlags): Promise<FirebaseHashFlags> {
  const merged: FirebaseHashFlags = { ...flags };
  for (const [key, , settingName] of FIREBASE_FLAGS) {
    if (merged[key] !== undefined) continue;
    const setting = findSetting(settingName);
    const located = setting && (await findMigrateEnvValue(envNames(setting)));
    if (!located || located.value.trim() === "") continue;
    // A non-numeric round count is left to fail the flag's own validation
    // rather than silently becoming NaN.
    (merged as Record<string, unknown>)[key] = FIREBASE_NUMERIC.has(key)
      ? Number(located.value)
      : located.value;
  }
  return merged;
}

/**
 * Resolves the four parameters from flags, then the `CLERK_FIREBASE_*`
 * variables, then the project's env files.
 *
 * The four are required as a set: a digest built from a partial set is
 * well-formed but verifies against nothing, so every migrated user would fail
 * to sign in with no error at import time. How a partial set is treated depends
 * on where it came from — flags are an instruction, saved config is not.
 *
 * @param transformer - The platform being migrated. Anything but `firebase`
 *   returns immediately, without reading the environment.
 * @returns The config, or `undefined` when none was supplied — which is fine
 *   for an export that carries no password hashes.
 */
export async function resolveFirebaseHashConfig(
  flags: FirebaseHashFlags,
  transformer: string | undefined,
): Promise<FirebaseHashConfig | undefined> {
  if (transformer !== "firebase") return undefined;

  const fromFlags = FIREBASE_FLAGS.filter(([key]) => flags[key] !== undefined);
  const resolved = await withFirebaseEnv(flags);
  const provided = FIREBASE_FLAGS.filter(([key]) => resolved[key] !== undefined);

  if (provided.length === 0) return undefined;

  if (provided.length < FIREBASE_FLAGS.length) {
    const missing = FIREBASE_FLAGS.filter(([key]) => resolved[key] === undefined).map(
      ([, flag]) => flag,
    );

    // Saved config is a leftover, not an instruction: half a set in
    // `.env.clerk-migrate` should not fail the run, but on a Firebase import it
    // is the reason the passwords will not come across, so it is said out loud.
    if (fromFlags.length === 0) {
      log.warn(
        `Ignoring an incomplete Firebase hash configuration (no ${missing.join(", ")}). ` +
          "Run `clerk migrate settings` to see what is set.",
      );
      return undefined;
    }

    throwUsageError(
      `The Firebase hash parameters must be supplied together. Missing: ${missing.join(", ")}.\n` +
        "Find all four in the Firebase console under Authentication → Users → (⋮) → Password hash parameters.",
      "https://clerk.com/docs/guides/development/migrating/firebase",
    );
  }

  return {
    base64_signer_key: resolved.firebaseSignerKey as string,
    base64_salt_separator: resolved.firebaseSaltSeparator as string,
    rounds: resolved.firebaseRounds as number,
    mem_cost: resolved.firebaseMemCost as number,
  };
}
