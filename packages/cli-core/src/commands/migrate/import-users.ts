/**
 * Creates users in Clerk from a validated batch.
 *
 * Ported from the standalone migration-tool's `src/migrate/import-users.ts`,
 * rewritten onto `bapiRequest` instead of `@clerk/backend`. Two things fall out
 * of that move:
 *
 * - The request body is BAPI's snake_case shape directly, so `created_at` and
 *   `legal_accepted_at` stay RFC3339 strings rather than round-tripping
 *   through `Date`.
 * - `banned`, `delete_self_enabled` and the organization limits are all
 *   accepted by `POST /v1/users`, so the follow-up `updateUser`/`banUser`
 *   calls the SDK version needed are gone.
 *
 * Run state is local to {@link importUsers} rather than module-level, so two
 * runs in one process (or one test file) cannot see each other's counters.
 */

import { bapiRequest } from "../../lib/bapi.ts";
import { BapiError } from "../../lib/errors.ts";
import type { SpinnerControls } from "../../lib/spinner.ts";
import { errorLogger, importLogger } from "./lib/logger.ts";
import type { ResolvedLimits } from "./lib/instance.ts";
import { RateLimitExceededError, retryOn429 } from "./lib/retry.ts";
import { createApiScheduler, type ApiScheduler } from "./lib/scheduler.ts";
import type { ImportSummary, User } from "./types.ts";

// Re-exported for the tests and callers that grew up against this module.
export { readRetryAfter } from "./lib/retry.ts";

/**
 * Groups error messages that differ only in field ordering, so the summary
 * reports "12 users: [\"first_name\" \"last_name\"] ..." once instead of twice.
 */
export function normalizeErrorMessage(errorMessage: string): string {
  let normalized = "";
  let lastCopiedIndex = 0;
  let arrayStartIndex = -1;

  for (let i = 0; i < errorMessage.length; i++) {
    const char = errorMessage[i];

    if (arrayStartIndex === -1) {
      if (char === "[") arrayStartIndex = i;
      continue;
    }
    if (char !== "]") continue;

    normalized += errorMessage.slice(lastCopiedIndex, arrayStartIndex);
    normalized += normalizeFieldArray(errorMessage.slice(arrayStartIndex + 1, i));
    lastCopiedIndex = i + 1;
    arrayStartIndex = -1;
  }

  return normalized + errorMessage.slice(lastCopiedIndex);
}

function normalizeFieldArray(fields: string): string {
  const fieldNames: string[] = [];
  let current = "";

  for (const char of fields) {
    if (char === '"' || char === "'" || char.trim() === "") {
      if (current.length > 0) {
        fieldNames.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }
  if (current.length > 0) fieldNames.push(current);

  fieldNames.sort();
  return `[${fieldNames.map((name) => `"${name}"`).join(" ")}]`;
}

function toArray(value: string | string[] | undefined): string[] {
  if (!value) return [];
  return Array.isArray(value) ? value : [value];
}

function dedupe(values: string[]): string[] {
  const seen: string[] = [];
  for (const value of values) {
    if (value && !seen.includes(value)) seen.push(value);
  }
  return seen;
}

type Identifiers = {
  primaryEmail: string | undefined;
  additionalEmails: string[];
  unverifiedEmails: string[];
  primaryPhone: string | undefined;
  additionalPhones: string[];
  unverifiedPhones: string[];
};

/**
 * Splits a user's identifiers into the one that goes on `POST /v1/users` and
 * the rest, which are attached afterwards.
 */
export function splitIdentifiers(user: User): Identifiers {
  const verifiedEmails = dedupe([...toArray(user.email), ...toArray(user.emailAddresses)]);
  const verifiedPhones = dedupe([...toArray(user.phone), ...toArray(user.phoneNumbers)]);

  return {
    primaryEmail: verifiedEmails[0],
    additionalEmails: verifiedEmails.slice(1),
    unverifiedEmails: dedupe(
      toArray(user.unverifiedEmailAddresses).filter((email) => !verifiedEmails.includes(email)),
    ),
    primaryPhone: verifiedPhones[0],
    additionalPhones: verifiedPhones.slice(1),
    unverifiedPhones: dedupe(
      toArray(user.unverifiedPhoneNumbers).filter((phone) => !verifiedPhones.includes(phone)),
    ),
  };
}

/**
 * Builds the `POST /v1/users` request body.
 *
 * Optional fields are omitted rather than sent as null so Clerk applies its own
 * defaults for anything the source platform did not record.
 */
export function buildCreateUserBody(
  user: User,
  identifiers: Identifiers,
  skipPasswordRequirement: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = { external_id: user.userId };

  if (identifiers.primaryEmail) body.email_address = [identifiers.primaryEmail];
  if (identifiers.primaryPhone) body.phone_number = [identifiers.primaryPhone];
  if (user.firstName) body.first_name = user.firstName;
  if (user.lastName) body.last_name = user.lastName;
  if (user.username) body.username = user.username;
  if (user.totpSecret) body.totp_secret = user.totpSecret;
  if (user.backupCodes) body.backup_codes = user.backupCodes;
  if (user.unsafeMetadata) body.unsafe_metadata = user.unsafeMetadata;
  if (user.privateMetadata) body.private_metadata = user.privateMetadata;
  if (user.publicMetadata) body.public_metadata = user.publicMetadata;
  if (user.createdAt) body.created_at = user.createdAt;
  if (user.legalAcceptedAt) body.legal_accepted_at = user.legalAcceptedAt;
  if (user.skipLegalChecks !== undefined) body.skip_legal_checks = user.skipLegalChecks;
  if (user.skipPasswordChecks !== undefined) body.skip_password_checks = user.skipPasswordChecks;
  if (user.banned !== undefined) body.banned = user.banned;
  if (user.bypassClientTrust !== undefined) body.bypass_client_trust = user.bypassClientTrust;
  if (user.deleteSelfEnabled !== undefined) body.delete_self_enabled = user.deleteSelfEnabled;
  if (user.createOrganizationEnabled !== undefined) {
    body.create_organization_enabled = user.createOrganizationEnabled;
  }
  if (user.createOrganizationsLimit !== undefined) {
    body.create_organizations_limit = user.createOrganizationsLimit;
  }

  if (user.password && user.passwordHasher) {
    body.password_digest = user.password;
    body.password_hasher = user.passwordHasher;
  } else if (skipPasswordRequirement) {
    body.skip_password_requirement = true;
  }
  // Without a password and without skipPasswordRequirement, Clerk rejects the
  // user — which is exactly what --require-password is asking for.

  return body;
}

type CreateContext = {
  secretKey: string;
  schedule: ApiScheduler;
  dateTime: string;
};

/** Attaches one extra identifier, logging (but not rethrowing) any failure. */
async function attachIdentifier(
  ctx: CreateContext,
  userId: string,
  clerkUserId: string,
  kind: "email" | "phone",
  value: string,
  verified: boolean,
): Promise<void> {
  const path = kind === "email" ? "/v1/email_addresses" : "/v1/phone_numbers";
  const body =
    kind === "email"
      ? { user_id: clerkUserId, email_address: value, primary: false, verified }
      : { user_id: clerkUserId, phone_number: value, primary: false, verified };

  try {
    await ctx.schedule(() =>
      bapiRequest({
        method: "POST",
        path,
        secretKey: ctx.secretKey,
        body: JSON.stringify(body),
      }),
    );
  } catch (error) {
    const label = `${verified ? "additional" : "unverified"} ${kind} ${value}`;
    errorLogger(
      {
        userId,
        status: `additional_${kind}_error`,
        errors: [
          {
            code: `additional_${kind}_failed`,
            message: `Failed to add ${label}`,
            longMessage: `Failed to add ${label}: ${(error as Error).message}`,
          },
        ],
      },
      ctx.dateTime,
    );
  }
}

/** Creates one user, then attaches any additional identifiers it carries. */
async function createUser(
  ctx: CreateContext,
  user: User,
  skipPasswordRequirement: boolean,
): Promise<string> {
  const identifiers = splitIdentifiers(user);

  const response = await ctx.schedule(() =>
    bapiRequest({
      method: "POST",
      path: "/v1/users",
      secretKey: ctx.secretKey,
      body: JSON.stringify(buildCreateUserBody(user, identifiers, skipPasswordRequirement)),
    }),
  );

  const clerkUserId = (response.body as { id?: string })?.id ?? "";

  // Extra identifiers are best-effort: a duplicate secondary email should not
  // undo a user who was otherwise imported successfully.
  await Promise.all([
    ...identifiers.additionalEmails.map((email) =>
      attachIdentifier(ctx, user.userId, clerkUserId, "email", email, true),
    ),
    ...identifiers.unverifiedEmails.map((email) =>
      attachIdentifier(ctx, user.userId, clerkUserId, "email", email, false),
    ),
    ...identifiers.additionalPhones.map((phone) =>
      attachIdentifier(ctx, user.userId, clerkUserId, "phone", phone, true),
    ),
    ...identifiers.unverifiedPhones.map((phone) =>
      attachIdentifier(ctx, user.userId, clerkUserId, "phone", phone, false),
    ),
  ]);

  return clerkUserId;
}

export type ImportUsersOptions = {
  users: User[];
  secretKey: string;
  limits: ResolvedLimits;
  dateTime: string;
  /** Allow users that carry no password. */
  skipPasswordRequirement?: boolean;
  /** Carried into the summary so the report covers the whole file. */
  validationFailed?: number;
  spinner?: SpinnerControls;
};

/**
 * Imports every user, concurrently and within the instance's rate limit.
 *
 * A failed user is recorded and the run continues; a 429 backs off (honouring
 * `Retry-After`) and retries up to {@link MAX_RETRIES} times.
 */
export async function importUsers(options: ImportUsersOptions): Promise<ImportSummary> {
  const {
    users,
    secretKey,
    limits,
    dateTime,
    skipPasswordRequirement = true,
    validationFailed = 0,
    spinner,
  } = options;

  const total = users.length;
  const errorBreakdown = new Map<string, number>();
  let processed = 0;
  let successful = 0;
  let failed = 0;

  const ctx: CreateContext = {
    secretKey,
    dateTime,
    schedule: createApiScheduler(limits.concurrencyLimit, limits.rateLimit),
  };

  const progress = () =>
    spinner?.update(
      `Importing users: [${processed}/${total}] (${successful} succeeded, ${failed} failed)`,
    );

  const recordFailure = (userId: string, message: string, code: string) => {
    failed++;
    processed++;
    const normalized = normalizeErrorMessage(message);
    errorBreakdown.set(normalized, (errorBreakdown.get(normalized) ?? 0) + 1);
    importLogger({ userId, status: "error", error: message, code }, dateTime);
    progress();
  };

  const processUser = async (user: User): Promise<void> => {
    try {
      const clerkUserId = await retryOn429(() => createUser(ctx, user, skipPasswordRequirement), {
        onRetry: ({ message }) =>
          errorLogger(
            {
              userId: user.userId,
              status: "429_retry",
              errors: [{ code: "rate_limit_retry", message, longMessage: message }],
            },
            dateTime,
          ),
      });
      successful++;
      processed++;
      importLogger({ userId: user.userId, status: "success", clerkUserId }, dateTime);
      progress();
    } catch (error) {
      if (error instanceof RateLimitExceededError) {
        recordFailure(user.userId, error.message, "429");
        return;
      }

      const apiError = error as BapiError;
      const message = apiError.longMessage ?? apiError.message ?? "Unknown error";
      recordFailure(user.userId, message, String(apiError.status ?? "unknown"));
    }
  };

  progress();
  await Promise.all(users.map((user) => processUser(user)));

  return { totalProcessed: total, successful, failed, validationFailed, errorBreakdown };
}
