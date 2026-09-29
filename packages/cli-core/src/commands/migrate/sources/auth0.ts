import type { SourceEntry } from "../types.ts";
import { routeByVerification } from "./shared.ts";

/**
 * Auth0 → Clerk transformer.
 *
 * Works with Auth0's Export Users API. `user_id` is a `provider|id` string
 * (`auth0|abc123`, `github|12345`) and is carried through as the Clerk user's
 * `external_id`.
 *
 * Auth0 does not include password hashes in a standard export — they have to
 * be requested from Auth0 support. When present they are bcrypt (`$2a$`/`$2b$`,
 * 10 rounds), which is why `passwordHasher` defaults to `bcrypt`.
 */
const auth0Source = {
  key: "auth0",
  label: "Auth0",
  description:
    "Works with Auth0's Export Users API. Password hashes require a support request to Auth0.",
  carries: {
    passwords: {
      level: "partial",
      note: "Auth0 releases bcrypt hashes only through a support request. Add each as `passwordHash` before importing.",
    },
    mfa: { level: "no", note: "Auth0 exports no MFA enrolments. Users enrol again in Clerk." },
    metadata: {
      level: "yes",
      note: "`user_metadata` → public metadata, `app_metadata` → private metadata.",
    },
  },
  transformer: {
    user_id: "userId",
    email: "email",
    email_verified: "emailVerified",
    username: "username",
    given_name: "firstName",
    family_name: "lastName",
    phone_number: "phone",
    phone_verified: "phoneVerified",
    passwordHash: "password",
    user_metadata: "publicMetadata",
    app_metadata: "privateMetadata",
    created_at: "createdAt",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "boolean");
    routeByVerification(user, "phone", "phoneVerified", "boolean");
  },
  defaults: {
    passwordHasher: "bcrypt" as const,
  },
} satisfies SourceEntry;

export default auth0Source;
