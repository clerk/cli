import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, ERROR_CODE } from "../../../lib/errors.ts";
import type { PreTransformResult, TransformerRegistryEntry } from "../types.ts";
import { routeByVerification, splitName, toIsoDate } from "./shared.ts";

/**
 * Column order of `firebase auth:export --format=csv`, which writes no header
 * row. Without these the CSV parser would treat the first user as the header.
 */
const FIREBASE_CSV_HEADERS =
  "localId,email,emailVerified,passwordHash,passwordSalt,displayName,photoUrl," +
  "googleId,googleEmail,googleDisplayName,googlePhotoUrl," +
  "facebookId,facebookEmail,facebookDisplayName,facebookPhotoUrl," +
  "twitterId,twitterEmail,twitterDisplayName,twitterPhotoUrl," +
  "githubId,githubEmail,githubDisplayName,githubPhotoUrl," +
  "createdAt,lastSignedInAt,phoneNumber,disabled,customAttributes,providerUserInfo";

/**
 * Firebase → Clerk transformer.
 *
 * Handles both shapes `firebase auth:export` produces: a headerless CSV, and
 * JSON wrapped in `{ users: [...] }`.
 *
 * Firebase's scrypt is a modified variant, so Clerk needs the project's four
 * hash parameters alongside each digest. They arrive on the run's
 * {@link TransformContext} from `--firebase-*` flags or saved `.settings`.
 *
 * See https://clerk.com/docs/guides/development/migrating/firebase
 */
const firebaseTransformer = {
  key: "firebase",
  label: "Firebase",
  description:
    "Works with `firebase auth:export` (CSV or JSON). Requires the project's four password hash parameters to migrate passwords.",

  preTransform: (filePath: string, fileType: string): PreTransformResult => {
    if (fileType === "text/csv") {
      // Written to the OS temp dir rather than the user's cwd: this is a
      // parsing artifact, not a migration output like ./logs.
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "clerk-migrate-firebase-"));
      const withHeaders = path.join(tmpDir, path.basename(filePath));
      fs.writeFileSync(
        withHeaders,
        `${FIREBASE_CSV_HEADERS}\n${fs.readFileSync(filePath, "utf-8")}`,
      );
      return { filePath: withHeaders };
    }

    if (fileType === "application/json") {
      const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf-8"));
      if (Array.isArray(parsed)) return { filePath, data: parsed as Record<string, unknown>[] };

      const users = (parsed as { users?: unknown })?.users;
      if (Array.isArray(users)) return { filePath, data: users as Record<string, unknown>[] };

      throw new CliError(
        "Invalid Firebase JSON export: expected `{ users: [...] }` or an array of users.",
        { code: ERROR_CODE.INVALID_JSON },
      );
    }

    return { filePath };
  },

  transformer: {
    localId: "userId",
    email: "email",
    emailVerified: "emailVerified",
    passwordHash: "passwordHash",
    passwordSalt: "salt",
    phoneNumber: "phone",
    displayName: "name",
  },

  postTransform: (user, context) => {
    const passwordHash = user.passwordHash;
    const salt = user.salt;

    if (passwordHash && salt) {
      const config = context.firebaseHashConfig;
      if (!config) {
        throw new CliError(
          "This export contains Firebase password hashes, which need the project's hash parameters to import.\n" +
            "Find them in the Firebase console under Authentication → Users → (⋮) → Password hash parameters, then pass:\n" +
            "  --firebase-signer-key --firebase-salt-separator --firebase-rounds --firebase-mem-cost",
          {
            code: ERROR_CODE.USAGE_ERROR,
            docsUrl: "https://clerk.com/docs/guides/development/migrating/firebase",
          },
        );
      }

      // Clerk's scrypt_firebase hasher expects every parameter inline:
      // hash$salt$signerKey$saltSeparator$rounds$memCost
      user.password = [
        passwordHash,
        salt,
        config.base64_signer_key,
        config.base64_salt_separator,
        config.rounds,
        config.mem_cost,
      ].join("$");

      delete user.passwordHash;
      delete user.salt;
    }

    routeByVerification(user, "email", "emailVerified", "boolean");
    // Firebase exports timestamps as Unix milliseconds, often as strings.
    user.createdAt = toIsoDate(user.createdAt, true);
    splitName(user);
  },

  defaults: {
    passwordHasher: "scrypt_firebase" as const,
  },
} satisfies TransformerRegistryEntry;

export default firebaseTransformer;
