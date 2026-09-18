import type { TransformerRegistryEntry } from "../types.ts";

/**
 * Clerk → Clerk transformer, for moving users between Clerk instances
 * (typically development → production).
 *
 * Maps the Dashboard's user export format onto the import schema.
 */
const clerkTransformer = {
  key: "clerk",
  label: "Clerk",
  description:
    "Migrate between Clerk instances (e.g. development to production, or to another Clerk application). Export your users from the Clerk Dashboard first.",
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
} satisfies TransformerRegistryEntry;

export default clerkTransformer;
