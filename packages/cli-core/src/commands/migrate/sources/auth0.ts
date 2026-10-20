import type { SourceEntry } from "../types.ts";
import { isVerified, routeByVerification, splitName } from "./shared.ts";

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
/** Auth0 social connections named differently from Clerk's provider key. */
const AUTH0_PROVIDER_KEYS: Record<string, string> = {
  "google-oauth2": "google",
  windowslive: "microsoft",
  linkedin: "linkedin_oidc",
};

/**
 * `user_id` prefixes that are not social sign-in: the database, passwordless,
 * enterprise connections, and custom `oauth2` ones Clerk cannot match by name.
 */
const AUTH0_NOT_SOCIAL = new Set([
  "auth0",
  "email",
  "sms",
  "samlp",
  "waad",
  "adfs",
  "ad",
  "oidc",
  "okta",
  "pingfederate",
  "google-apps",
  "oauth2",
]);

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
      note: "`user_metadata` → unsafe metadata, which users can edit, as in Auth0. `app_metadata` → private metadata.",
    },
  },
  transformer: {
    user_id: "userId",
    email: "email",
    email_verified: "emailVerified",
    username: "username",
    name: "name",
    blocked: "banned",
    given_name: "firstName",
    family_name: "lastName",
    phone_number: "phone",
    phone_verified: "phoneVerified",
    passwordHash: "password",
    user_metadata: "unsafeMetadata",
    app_metadata: "privateMetadata",
    created_at: "createdAt",
  },
  postTransform: (user) => {
    routeByVerification(user, "email", "emailVerified", "boolean");
    routeByVerification(user, "phone", "phoneVerified", "boolean");

    // given_name/family_name win when present. Auth0 fills `name` with the
    // email for database users; splitName drops an email-shaped value.
    if (user.firstName || user.lastName) delete user.name;
    else splitName(user);

    // Runs before normalizeUserData, so accept CSV's "true" as well.
    if (isVerified(user.banned, "boolean")) user.banned = true;
    else delete user.banned;
  },

  // The prefix names the connection the user signed up with. A user who later
  // linked another provider is counted only under the first.
  socialProviders: (user) => {
    const separator = user.userId.indexOf("|");
    if (separator < 1) return [];
    const connection = user.userId.slice(0, separator);
    if (AUTH0_NOT_SOCIAL.has(connection)) return [];
    return [AUTH0_PROVIDER_KEYS[connection] ?? connection];
  },

  defaults: {
    passwordHasher: "bcrypt" as const,
  },
} satisfies SourceEntry;

export default auth0Source;
