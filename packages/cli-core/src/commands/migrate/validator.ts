/**
 * Zod schema every user is validated against before it reaches BAPI.
 *
 * Ported from the standalone migration-tool's `src/migrate/validator.ts`.
 *
 * ============================================================================
 * ONLY EDIT THIS IF YOU ARE ADDING A NEW FIELD.
 * Adding support for a new source platform means adding a source, not
 * touching the schema.
 * ============================================================================
 */

import * as z from "zod";
import { PASSWORD_HASHERS } from "./types.ts";

const metadataSchema = z.record(z.string(), z.unknown());

const dateStringSchema = z.string().refine((value) => !Number.isNaN(new Date(value).getTime()), {
  message: "Expected a valid date string",
});

/** Zod enum of the password hashers Clerk accepts on import. */
export const passwordHasherEnum = z.enum(PASSWORD_HASHERS, {
  error: (issue) =>
    `Unknown password hasher ${JSON.stringify(issue.input)}. Expected one of: ${PASSWORD_HASHERS.join(", ")}`,
});

/**
 * Validates user data before sending it to Clerk.
 *
 * Everything is optional except:
 * - `userId`, required for tracking, re-runs and `undo`
 * - `passwordHasher`, required whenever `password` is present
 * - at least one identifier (email, phone or username)
 *
 * Identifier fields accept either a single value or an array.
 */
export const userSchema = z
  .object({
    userId: z.string(),
    // Email fields
    // Strings, not z.email(): an address Clerk would refuse is dropped by the
    // checks, with a warning, rather than taking the whole user down.
    email: z.union([z.string(), z.array(z.string())]).optional(),
    emailAddresses: z.union([z.string(), z.array(z.string())]).optional(),
    unverifiedEmailAddresses: z.union([z.string(), z.array(z.string())]).optional(),
    // Phone fields
    phone: z.union([z.string(), z.array(z.string())]).optional(),
    phoneNumbers: z.union([z.string(), z.array(z.string())]).optional(),
    unverifiedPhoneNumbers: z.union([z.string(), z.array(z.string())]).optional(),
    // User info
    username: z.string().optional(),
    firstName: z.string().optional(),
    lastName: z.string().optional(),
    // Password
    password: z.string().optional(),
    passwordHasher: passwordHasherEnum.optional(),
    /** Set by a source that found a password Clerk cannot verify, and left it out. */
    passwordDropped: z.boolean().optional(),
    // Set by a source for a user that should not be created at all; the checks
    // reject it with this reason. Never sent to Clerk.
    skipReason: z.string().optional(),
    // 2FA
    totpSecret: z.string().optional(),
    backupCodesEnabled: z.boolean().optional(),
    backupCodes: z.array(z.string()).optional(),
    // Metadata
    unsafeMetadata: metadataSchema.optional(),
    publicMetadata: metadataSchema.optional(),
    privateMetadata: metadataSchema.optional(),
    // Additional Clerk API fields
    banned: z.boolean().optional(),
    bypassClientTrust: z.boolean().optional(),
    createOrganizationEnabled: z.boolean().optional(),
    createOrganizationsLimit: z.number().int().optional(),
    createdAt: dateStringSchema.optional(),
    deleteSelfEnabled: z.boolean().optional(),
    legalAcceptedAt: dateStringSchema.optional(),
    skipLegalChecks: z.boolean().optional(),
    skipPasswordChecks: z.boolean().optional(),
  })
  .refine((data) => !data.password || data.passwordHasher, {
    message: "passwordHasher is required when password is provided",
    path: ["passwordHasher"],
  })
  .refine(
    (data) => {
      const hasValue = (field: unknown): boolean => {
        if (!field) return false;
        if (typeof field === "string") return field.length > 0;
        if (Array.isArray(field)) return field.length > 0;
        return false;
      };
      return (
        hasValue(data.email) ||
        hasValue(data.emailAddresses) ||
        hasValue(data.unverifiedEmailAddresses) ||
        hasValue(data.phone) ||
        hasValue(data.phoneNumbers) ||
        hasValue(data.unverifiedPhoneNumbers) ||
        hasValue(data.username)
      );
    },
    {
      message:
        "User must have at least one identifier (email, phone, unverified email, unverified phone, or username)",
      path: ["email"],
    },
  );
