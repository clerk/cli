import type { TransformerRegistryEntry } from "../types.ts";
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
 * No password default: Auth.js's core is passwordless (OAuth and email links),
 * so users arrive without a digest and are imported with
 * `skip_password_requirement`.
 */
const authjsTransformer = {
  key: "authjs",
  label: "Auth.js (NextAuth)",
  description:
    "Assumes an export of `SELECT id, name, email, email_verified, created_at FROM users`. `name` is split into firstName and lastName.",
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
} satisfies TransformerRegistryEntry;

export default authjsTransformer;
