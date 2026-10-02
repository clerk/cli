import type { SourceEntry } from "../types.ts";
import { detectStandardHasher, isVerified, routeByVerification, splitName } from "./shared.ts";

/**
 * Better Auth → Clerk source.
 *
 * Works with `clerk migrate export betterauth`, which joins the user table
 * with the credential account row to pick up the stored `password_hash`.
 *
 * Better Auth plugins add columns Clerk has no equivalent for
 * (`display_username`, `role`, `ban_reason`, `two_factor_enabled`). They need
 * no handling: the schema strips anything it does not declare. `banned` is the
 * exception, because that one *is* a Clerk field.
 */

/** Better Auth's own scrypt: `<32 hex salt>:<128 hex key>`, N=16384, r=16, p=1. */
const BETTER_AUTH_SCRYPT = /^([0-9a-f]{32}):([0-9a-f]{128})$/i;

/**
 * Works out which hasher produced a stored Better Auth password, one user at
 * a time.
 *
 * Better Auth hashes with its own scrypt by default and lets an app swap in
 * bcrypt or argon2, so one database can hold more than one kind. Better Auth's
 * scrypt uses the hex salt string itself as the salt and a 64-byte key, which
 * is exactly what `scrypt_werkzeug` verifies once the parameters are written
 * inline.
 *
 * @returns The digest and hasher to send, or `undefined` when the hash is not
 *   one Clerk can verify.
 */
export function detectBetterAuthHash(
  hash: string,
):
  | { password: string; passwordHasher: "scrypt_werkzeug" | "bcrypt" | "argon2id" | "argon2i" }
  | undefined {
  const scrypt = BETTER_AUTH_SCRYPT.exec(hash);
  if (scrypt) {
    return {
      password: `scrypt:16384:16:1$${scrypt[1]}$${scrypt[2]}`,
      passwordHasher: "scrypt_werkzeug",
    };
  }
  const passwordHasher = detectStandardHasher(hash);
  return passwordHasher ? { password: hash, passwordHasher } : undefined;
}

const betterAuthSource = {
  key: "betterauth",
  label: "Better Auth",
  description:
    "Works with the Better Auth export. Detects scrypt, bcrypt and argon2 passwords per user, and carries the admin plugin's banned flag.",
  carries: {
    passwords: {
      level: "yes",
      note: "Better Auth's scrypt, bcrypt and argon2 hashes come across, detected per user. Any other hash is dropped, and that user resets their password.",
    },
    mfa: {
      level: "no",
      note: "The two-factor plugin's secrets are not exported. Users enrol again in Clerk.",
    },
    metadata: {
      level: "no",
      note: "Plugin columns such as `role` have no Clerk equivalent and are left out.",
    },
  },
  caveats: [
    "Better Auth's scrypt normalizes a password to NFKC before hashing it; Clerk hashes it as typed. A password whose NFKC form differs — full-width characters, some ligatures — will not verify, and that user resets it.",
  ],
  transformer: {
    user_id: "userId",
    email: "email",
    email_verified: "emailVerified",
    name: "name",
    password_hash: "password",
    username: "username",
    phone_number: "phone",
    phone_number_verified: "phoneVerified",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "boolean");
    routeByVerification(user, "phone", "phoneVerified", "boolean");
    splitName(user);

    if (typeof user.password === "string" && user.password) {
      const detected = detectBetterAuthHash(user.password);
      if (detected) {
        user.password = detected.password;
        user.passwordHasher = detected.passwordHasher;
      } else {
        // Imported without it rather than rejected: the user can still sign
        // in another way, or reset it.
        delete user.password;
        user.passwordDropped = true;
      }
    }

    // Only carry `banned` when it is actually true — Better Auth writes false
    // for every user that was never banned, and sending that to Clerk is noise.
    // SQLite, libSQL and MySQL hand back 1/0 and CSV hands back "true", so this
    // runs before normalizeUserData and must accept those too.
    if (isVerified(user.banned, "boolean")) user.banned = true;
    else delete user.banned;

    // The anonymous plugin's guests are throwaway accounts with placeholder
    // emails (anon-…@…), not people to migrate.
    if (isVerified(user.isAnonymous ?? user.is_anonymous, "boolean")) {
      user.skipReason = "anonymous Better Auth user";
    }
    delete user.isAnonymous;
    delete user.is_anonymous;
  },
} satisfies SourceEntry;

export default betterAuthSource;
