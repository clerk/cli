import type { PASSWORD_HASHERS, SourceEntry } from "../types.ts";
import { detectStandardHasher, routeByVerification } from "./shared.ts";

/**
 * WorkOS → Clerk transformer.
 *
 * Works with WorkOS's User Management API. `id` is a `user_…` string and is
 * carried through as the Clerk user's `external_id`. WorkOS's own `external_id`
 * — the tenant's app ID, when they set one — has nowhere else to go, so it lands
 * in private metadata as `workosExternalId`: private because users can edit
 * unsafe metadata, and an ID other records key on must not be editable.
 *
 * **Password hashes come only from WorkOS support.** The API returns none, and
 * returns TOTP secrets only at enrolment. WorkOS support sends hashes on
 * request as a CSV, which `export workos --password-hashes` merges in as
 * `password_hash`. There is no `passwordHasher` default: one export can hold
 * several formats, so `detectWorkOsHash` names the hasher per user.
 *
 * WorkOS has no phone number and no username, which is why the map is short:
 * those fields have nothing to come from.
 */

type PasswordHasher = (typeof PASSWORD_HASHERS)[number];

/** WorkOS formats Clerk verifies unchanged, named with underscores. */
const AS_IS =
  /^\$(bcrypt-pbkdf2-sha1|bcrypt-pbkdf2-sha256|bcrypt-ssha|bcrypt-ssha256|scrypt)\$v=1\$/;

// clerk_go's limits (pkg/hash): pbkdf2_sha256 derives exactly 32 bytes, and
// pbkdf2_sha512_hex takes at most 420,000 iterations and at least a 16-byte key.
const PBKDF2_SHA256_KEY_BYTES = 32;
const PBKDF2_SHA512_MAX_ITERATIONS = 420_000;
const PBKDF2_SHA512_MIN_KEY_BYTES = 16;

/**
 * Names the Clerk hasher for one hash from a WorkOS export, rewriting it into
 * that hasher's layout where WorkOS's PHC string differs.
 *
 * The formats are listed under "Password hash formats" in
 * https://workos.com/docs/migrate/export-from-workos. Salts and digests are
 * base64 with the padding trimmed.
 *
 * @returns `undefined` for a hash Clerk can't verify: argon2d,
 *   firebase-scrypt, and pbkdf2 outside clerk_go's limits.
 */
export function detectWorkOsHash(
  hash: string,
): { password: string; passwordHasher: PasswordHasher } | undefined {
  const standard = detectStandardHasher(hash);
  if (standard) return { password: hash, passwordHasher: standard };

  const asIs = AS_IS.exec(hash)?.[1];
  if (asIs) {
    return { password: hash, passwordHasher: asIs.replaceAll("-", "_") as PasswordHasher };
  }

  // $pbkdf2$i=600000,d=sha256$<salt>$<key>, with the params in any order.
  const pbkdf2 = /^\$pbkdf2\$([^$]+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/.exec(hash);
  if (!pbkdf2) return undefined;
  const [, rawParams = "", rawSalt = "", rawKey = ""] = pbkdf2;
  const params = new URLSearchParams(rawParams.replaceAll(",", "&"));
  const iterations = params.get("i") ?? "";
  if (!/^[1-9]\d*$/.test(iterations)) return undefined;
  const salt = Buffer.from(rawSalt, "base64");
  const key = Buffer.from(rawKey, "base64");

  switch (params.get("d")) {
    case "sha256":
      if (key.length !== PBKDF2_SHA256_KEY_BYTES) return undefined;
      return {
        password: `pbkdf2_sha256$${iterations}$${salt.toString("base64")}$${key.toString("base64")}`,
        passwordHasher: "pbkdf2_sha256",
      };
    case "sha512":
      if (Number(iterations) > PBKDF2_SHA512_MAX_ITERATIONS) return undefined;
      if (key.length < PBKDF2_SHA512_MIN_KEY_BYTES) return undefined;
      return {
        password: `pbkdf2_sha512_hex$${iterations}$${salt.toString("hex")}$${key.toString("hex")}`,
        passwordHasher: "pbkdf2_sha512_hex",
      };
    case "sha1":
      // WorkOS re-hashes sha1 with bcrypt at import, so this is only a
      // fallback. The fifth segment is the key length; clerk_go assumes 32.
      return {
        password: `pbkdf2_sha1$${iterations}$${salt.toString("hex")}$${key.toString("hex")}$${key.length}`,
        passwordHasher: "pbkdf2_sha1",
      };
    default:
      return undefined;
  }
}

const workosSource = {
  key: "workos",
  label: "WorkOS",
  description:
    "Works with WorkOS's User Management API. Password hashes come from WorkOS support as a CSV, merged in by `export workos --password-hashes`.",
  carries: {
    passwords: {
      level: "partial",
      note: "Only from the CSV WorkOS support sends, merged in by `export workos --password-hashes`. Clerk can't verify argon2d, firebase-scrypt, or some pbkdf2 hashes, so those users reset their password.",
    },
    mfa: { level: "no", note: "WorkOS returns TOTP secrets at enrolment only." },
    metadata: {
      level: "yes",
      note: "`metadata` → private metadata, with WorkOS's `external_id` as `workosExternalId`; the WorkOS `id` becomes the Clerk external ID. Keys an app exposed through a WorkOS JWT template belong in public metadata: move them after the import.",
    },
  },
  transformer: {
    id: "userId",
    email: "email",
    email_verified: "emailVerified",
    first_name: "firstName",
    last_name: "lastName",
    // Only a backend with the secret key can set it, and the client never sees
    // it unless a JWT template puts a key in the token: private, not the
    // user-editable unsafe metadata, which an app could be trusting for a plan.
    metadata: "privateMetadata",
    external_id: "workosExternalId",
    created_at: "createdAt",
    password_hash: "password",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "boolean");

    if (typeof user.password === "string" && user.password) {
      const detected = detectWorkOsHash(user.password);
      if (detected) {
        user.password = detected.password;
        user.passwordHasher = detected.passwordHasher;
      } else {
        // Imported without it rather than rejected: the user resets instead.
        delete user.password;
        user.passwordDropped = true;
      }
    }

    if (user.workosExternalId) {
      const metadata =
        user.privateMetadata && typeof user.privateMetadata === "object"
          ? user.privateMetadata
          : {};
      user.privateMetadata = { ...metadata, workosExternalId: String(user.workosExternalId) };
    }
    delete user.workosExternalId;
  },
} satisfies SourceEntry;

export default workosSource;
