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
 * `email_verified` is a nullable timestamp rather than a boolean — any value
 * means verified.
 *
 * No password default: Auth.js core stores no passwords, so users arrive
 * without a digest and are imported with `skip_password_requirement`. An app
 * using the Credentials provider keeps its own, which this does not read.
 */
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
      note: "Only `id`, `name`, `email`, `email_verified` and `created_at` are read.",
    },
  },
  transformer: {
    id: "userId",
    email: "email",
    email_verified: "emailVerified",
    name: "name",
    created_at: "createdAt",
    updated_at: "updatedAt",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "timestamp");
    splitName(user);
  },
} satisfies SourceEntry;

export default authjsSource;
