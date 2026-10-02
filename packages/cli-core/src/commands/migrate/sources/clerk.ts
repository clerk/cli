import type { SourceEntry } from "../types.ts";

/**
 * Clerk → Clerk transformer, for moving users between Clerk instances
 * (typically development → production).
 *
 * Maps the Dashboard's user export format onto the import schema.
 */
const clerkSource = {
  key: "clerk",
  label: "Clerk",
  description:
    "Migrate between Clerk instances (e.g. development to production, or to another Clerk application). Export your users from the Clerk Dashboard first.",
  carries: {
    passwords: {
      level: "partial",
      note: "A Dashboard export carries each digest and its hasher. `clerk migrate export clerk` cannot: the Backend API never returns them.",
    },
    mfa: {
      level: "partial",
      note: "TOTP secrets and backup codes come across from a Dashboard export only.",
    },
    metadata: {
      level: "partial",
      note: "With `clerk migrate export clerk`, public, private and unsafe metadata keep their places; a Dashboard CSV carries no metadata, ban or legal acceptance. `export clerk` moves each user's external_id to private metadata as `clerkExternalId`, because the import uses external_id for the old Clerk ID.",
    },
  },
  transformer: {
    id: "userId",
    primary_email_address: "email",
    verified_email_addresses: "emailAddresses",
    unverified_email_addresses: "unverifiedEmailAddresses",
    first_name: "firstName",
    last_name: "lastName",
    password_digest: "password",
    password_hasher: "passwordHasher",
    primary_phone_number: "phone",
    verified_phone_numbers: "phoneNumbers",
    unverified_phone_numbers: "unverifiedPhoneNumbers",
    username: "username",
    totp_secret: "totpSecret",
    backup_codes_enabled: "backupCodesEnabled",
    backup_codes: "backupCodes",
    public_metadata: "publicMetadata",
    unsafe_metadata: "unsafeMetadata",
    private_metadata: "privateMetadata",
    // Account state a Dashboard export carries and `POST /v1/users` accepts.
    // Unmapped, these survive the export and are then silently stripped at
    // validation — losing original signup dates on a dev → prod migration.
    created_at: "createdAt",
    legal_accepted_at: "legalAcceptedAt",
    banned: "banned",
    create_organization_enabled: "createOrganizationEnabled",
    create_organizations_limit: "createOrganizationsLimit",
    delete_self_enabled: "deleteSelfEnabled",
  },
  postTransform: (user) => {
    // The Dashboard's CSV prefixes a TAB to any value starting with = + - @
    // (or their fullwidth forms), so a spreadsheet won't run it as a formula
    // (clerk_go pkg/csvsafe). Undo it, or the TAB is imported.
    for (const field of FORMULA_SAFE_FIELDS) {
      const value = user[field];
      if (typeof value === "string") user[field] = unprefix(value);
      else if (Array.isArray(value))
        user[field] = value.map((v) => (typeof v === "string" ? unprefix(v) : v));
    }
  },
} satisfies SourceEntry;

const FORMULA_SAFE_FIELDS = [
  "firstName",
  "lastName",
  "username",
  "email",
  "emailAddresses",
  "unverifiedEmailAddresses",
] as const;

const unprefix = (value: string) => value.replace(/^\t(?=[=+\-@\t\r\n＝＋－＠])/, "");

export default clerkSource;
