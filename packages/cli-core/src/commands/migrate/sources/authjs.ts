import type { SourceEntry } from "../types.ts";
import { routeByVerification, splitName } from "./shared.ts";

/**
 * Auth.js (formerly NextAuth) → Clerk transformer.
 *
 * Auth.js has no export tool and no fixed user table, so this assumes the
 * common shape: `SELECT id, name, email, email_verified, created_at FROM users`.
 * A different schema means editing the mapping below or supplying a custom
 * transformer file.
 *
 * `email_verified` is a nullable timestamp rather than a boolean: any real
 * date means verified. `0` (the epoch) and a value that isn't a date don't,
 * as the export reads them; digits alone are a stored integer timestamp.
 *
 * No password default: Auth.js core stores no passwords, so users arrive
 * without a digest and are imported with `skip_password_requirement`. An app
 * using the Credentials provider keeps its own, which this does not read.
 *
 * `providers` is what `export authjs` reads from the account table: each
 * user's OAuth providers, by Auth.js provider ID. They feed the readiness
 * check, which offers to turn on any Clerk has off.
 */
/** Auth.js provider IDs named differently from Clerk's provider key. */
const AUTHJS_PROVIDER_KEYS: Record<string, string> = {
  "azure-ad": "microsoft",
  "microsoft-entra-id": "microsoft",
  linkedin: "linkedin_oidc",
};

const authjsSource = {
  key: "authjs",
  label: "Auth.js (NextAuth)",
  description:
    "Assumes an export of `SELECT id, name, email, email_verified, created_at FROM users`. `name` is split into firstName and lastName.",
  carries: {
    passwords: {
      level: "no",
      note: "Auth.js core stores no passwords. An app using the Credentials provider keeps its own, which this does not read: migrate them separately, or have those users reset their password.",
    },
    mfa: { level: "no", note: "Auth.js has no MFA of its own." },
    metadata: {
      level: "no",
      note: "Only `id`, `name`, `email`, `email_verified`, `created_at` and the account table's OAuth providers are read.",
    },
  },
  transformer: {
    id: "userId",
    email: "email",
    email_verified: "emailVerified",
    name: "name",
    created_at: "createdAt",
    providers: "socialProviders",
  },
  postTransform: (user) => {
    const verified = user.emailVerified;
    if (
      verified === 0 ||
      (typeof verified === "string" &&
        (/^\d+$/.test(verified.trim())
          ? Number(verified) === 0
          : Number.isNaN(Date.parse(verified))))
    ) {
      user.emailVerified = null;
    }
    routeByVerification(user, "email", "emailVerified", "timestamp");
    splitName(user);
  },

  socialProviders: (user) =>
    (user.socialProviders ?? []).map((provider) => AUTHJS_PROVIDER_KEYS[provider] ?? provider),
} satisfies SourceEntry;

export default authjsSource;
