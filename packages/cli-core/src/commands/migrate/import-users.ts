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
import { interruptSignal } from "../../lib/signals.ts";
import type { ResolvedLimits } from "./lib/instance.ts";
import type { ProgressUpdate } from "./lib/progress.ts";
import { RateLimitExceededError, retryOn429 } from "./lib/retry.ts";
import type { PendingIdentifier, UserLine } from "./lib/run-store.ts";
import { RUN_MARKER_KEY } from "./lib/user-lookup.ts";
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
  // The instance's allowlist, blocklist, disposable-email and subaddress rules
  // police sign-ups. These users already signed up, on the source platform.
  const body: Record<string, unknown> = { external_id: user.userId, skip_restriction_checks: true };

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
  /** The run sending these creates; each carries it as its marker. */
  runId?: string;
  /** Aborted by the first `user_quota_exceeded`: every later create would be refused too. */
  quota: AbortController;
  /** Aborted by a Ctrl-C or the quota. No create goes out after it. */
  stop: AbortSignal;
};

/** A request a stop kept from going out: neither a failure nor unknown. */
class NotSentError extends Error {}

/**
 * True when no answer says whether a request landed: an abort, a network
 * error, or a 5xx after which Clerk may still have committed it. A 4xx, and a
 * 429 that ran out of retries, are definite refusals.
 */
export function outcomeUnknown(error: unknown): boolean {
  if (error instanceof RateLimitExceededError) return false;
  if (error instanceof BapiError) return error.status >= 500;
  return true;
}

/** The extra identifiers a user carries, in the order they are attached. */
export function pendingIdentifiers(identifiers: Identifiers): PendingIdentifier[] {
  return [
    ...identifiers.additionalEmails.map((value) => ({
      kind: "email" as const,
      value,
      verified: true,
    })),
    ...identifiers.unverifiedEmails.map((value) => ({
      kind: "email" as const,
      value,
      verified: false,
    })),
    ...identifiers.additionalPhones.map((value) => ({
      kind: "phone" as const,
      value,
      verified: true,
    })),
    ...identifiers.unverifiedPhones.map((value) => ({
      kind: "phone" as const,
      value,
      verified: false,
    })),
  ];
}

/**
 * Attaches one extra identifier, backing off on a 429.
 *
 * @returns A note when Clerk refused it, `pending` when nothing says whether
 *   it attached. Never throws: the user itself was already created.
 */
async function attachIdentifier(
  ctx: CreateContext,
  clerkUserId: string,
  { kind, value, verified }: PendingIdentifier,
): Promise<{ note?: string; pending?: boolean }> {
  const path = kind === "email" ? "/v1/email_addresses" : "/v1/phone_numbers";
  const body =
    kind === "email"
      ? { user_id: clerkUserId, email_address: value, primary: false, verified }
      : { user_id: clerkUserId, phone_number: value, primary: false, verified };

  // A Ctrl-C ends the wait for a slot or a backoff, and the attach is left
  // pending for a re-run. The quota does not: the user exists already.
  const stop = interruptSignal();
  try {
    await retryOn429(
      async () =>
        ctx.schedule(
          async () => {
            if (stop.aborted) throw new NotSentError();
            return bapiRequest({
              method: "POST",
              path,
              secretKey: ctx.secretKey,
              body: JSON.stringify(body),
            });
          },
          { first: true, stop },
        ),
      { signal: stop, onRetry: ({ delaySeconds }) => ctx.schedule.pause(delaySeconds * 1000) },
    );
    return {};
  } catch (error) {
    if (error instanceof NotSentError || outcomeUnknown(error)) return { pending: true };
    const label = `${verified ? "additional" : "unverified"} ${kind} ${value}`;
    return { note: `Failed to add ${label}: ${(error as Error).message}` };
  }
}

/**
 * Attaches each identifier. Extra identifiers are best-effort: a duplicate
 * secondary email should not undo a user who was otherwise imported.
 *
 * @returns A note per identifier Clerk refused, and those still pending.
 */
async function attachAll(
  ctx: CreateContext,
  clerkUserId: string,
  identifiers: PendingIdentifier[],
): Promise<{ notes: string[]; pending: PendingIdentifier[] }> {
  const results = await Promise.all(
    identifiers.map(async (identifier) => attachIdentifier(ctx, clerkUserId, identifier)),
  );
  return {
    notes: results.flatMap((result) => (result.note ? [result.note] : [])),
    pending: identifiers.filter((_, index) => results[index]?.pending),
  };
}

/**
 * Creates one user, retrying without a phone Clerk refuses.
 *
 * @param sending - Called as each `POST /v1/users` goes out, so the run
 *   records the user only once a create may actually land.
 * @returns The Clerk ID, a note when the phone was dropped, and Clerk's
 *   reason for refusing it.
 */
async function createUser(
  ctx: CreateContext,
  user: User,
  identifiers: Identifiers,
  skipPasswordRequirement: boolean,
  sending: () => void,
): Promise<{ clerkUserId: string; notes: string[]; phoneRefusal?: string }> {
  // A Ctrl-C or a full instance hands the slot on to queued creates; none
  // of them is sent, and none waits for a paced turn to find that out.
  const create = async (body: Record<string, unknown>) =>
    ctx.schedule(
      async () => {
        if (ctx.stop.aborted) throw new NotSentError();
        sending();
        return bapiRequest({
          method: "POST",
          path: "/v1/users",
          secretKey: ctx.secretKey,
          body: JSON.stringify(body),
        });
      },
      { stop: ctx.stop },
    );

  const body = buildCreateUserBody(user, identifiers, skipPasswordRequirement);
  // The run's marker, with whatever private metadata the source brought:
  // without it a create cut off mid-flight could never be told from a user
  // someone else made with the same external_id.
  if (ctx.runId) {
    body.private_metadata = {
      ...(body.private_metadata as Record<string, unknown> | undefined),
      [RUN_MARKER_KEY]: ctx.runId,
    };
  }
  const notes: string[] = [];
  let phoneRefusal: string | undefined;
  let response;
  try {
    response = await create(body);
  } catch (error) {
    // A phone Clerk refuses (a country it does not support, a number that is
    // not E.164) should not cost a user who has an email to be created under.
    // The country error names no parameter, only its own code.
    const phoneRefused =
      error instanceof BapiError &&
      (error.code === "unsupported_country_code" || error.meta?.param_name === "phone_number");
    if (!phoneRefused || !identifiers.primaryEmail) throw error;
    const { phone_number: _dropped, ...withoutPhone } = body;
    response = await create(withoutPhone);
    phoneRefusal = error.longMessage ?? error.message;
    notes.push(`Failed to add phone ${identifiers.primaryPhone}: ${phoneRefusal}`);
  }

  // Untracked, the user could never be undone. Thrown, the outcome is unknown,
  // so `creating` stays the latest line and a re-run looks the user up.
  const clerkUserId = (response.body as { id?: unknown })?.id;
  if (typeof clerkUserId !== "string" || !clerkUserId) {
    throw new Error("Clerk answered POST /v1/users without a user ID");
  }
  return { clerkUserId, notes, ...(phoneRefusal ? { phoneRefusal } : {}) };
}

export type ImportUsersOptions = {
  users: User[];
  secretKey: string;
  limits: ResolvedLimits;
  /** Receives each user's lines as they happen. */
  record: (line: UserLine) => void;
  /**
   * Users a continued run created whose extra identifiers never attached: their
   * latest `created` line, with `pending`. Only the attaches are sent.
   */
  attachOnly?: UserLine[];
  /** The run these creates belong to, sent on each as its marker. */
  runId?: string;
  /**
   * Source ID → Clerk ID for users whose create a stopped run sent with no
   * answer, and which a continued run then found in the instance. They are
   * not created again; only their extra identifiers are sent.
   */
  adopted?: Map<string, string>;
  /** Allow users that carry no password. */
  skipPasswordRequirement?: boolean;
  /** Carried into the summary so the report covers the whole file. */
  validationFailed?: number;
  /** Receives the counts as each user finishes. */
  progress?: ProgressUpdate;
};

/**
 * Imports every user, concurrently and within the instance's rate limit.
 *
 * A failed user is recorded and the run continues; a 429 backs off (honouring
 * `Retry-After`) and retries up to {@link MAX_RETRIES} times. A create with no
 * answer keeps its `creating` line, for a continued run or `undo` to resolve.
 */
export async function importUsers(options: ImportUsersOptions): Promise<ImportSummary> {
  const {
    users,
    secretKey,
    limits,
    record,
    attachOnly = [],
    runId,
    adopted = new Map<string, string>(),
    skipPasswordRequirement = true,
    validationFailed = 0,
    progress: report,
  } = options;

  const total = users.length;
  const errorBreakdown = new Map<string, number>();
  let processed = 0;
  let successful = 0;
  let failed = 0;
  let notSent = 0;
  let stopReason: string | undefined;
  const droppedPhones = new Map<string, number>();

  const quota = new AbortController();
  const ctx: CreateContext = {
    secretKey,
    schedule: createApiScheduler(limits.concurrencyLimit, limits.rateLimit),
    quota,
    stop: AbortSignal.any([interruptSignal(), quota.signal]),
    ...(runId ? { runId } : {}),
  };

  const progress = () => report?.({ done: processed, ok: successful, failed });

  const recordFailure = (
    userId: string,
    message: string,
    code: string,
    notes: string[],
    unknown: boolean,
  ) => {
    failed++;
    processed++;
    const normalized = normalizeErrorMessage(message);
    errorBreakdown.set(normalized, (errorBreakdown.get(normalized) ?? 0) + 1);
    // With no answer, the `creating` line stays the latest: Clerk may hold
    // the user, and a re-run looks it up before creating it again.
    if (!unknown) {
      record({ sourceId: userId, status: "failed", error: [message, ...notes].join("; "), code });
    }
    progress();
  };

  /**
   * Attaches a created user's extra identifiers. The user goes on record with
   * them `pending` first, so a run stopped before they attach can finish them.
   */
  const finishUser = async (line: UserLine, toAttach: PendingIdentifier[], notes: string[]) => {
    const { error: _error, pending: _pending, ...base } = line;
    if (toAttach.length > 0) record({ ...base, pending: toAttach });
    const attached = await attachAll(ctx, base.clerkId ?? "", toAttach);
    const error = [...notes, ...attached.notes].join("; ");
    // A second line, which wins as the latest, adds what happened on the way.
    if (toAttach.length > 0 || error) {
      record({
        ...base,
        ...(error ? { error } : {}),
        ...(attached.pending.length > 0 ? { pending: attached.pending } : {}),
      });
    }
  };

  const processUser = async (user: User): Promise<void> => {
    const retries: string[] = [];
    const identifiers = splitIdentifiers(user);
    let created: { clerkUserId: string; notes: string[]; phoneRefusal?: string };
    const adoptedId = adopted.get(user.userId);
    let sent = false;
    try {
      created = adoptedId
        ? { clerkUserId: adoptedId, notes: [] }
        : await retryOn429(
            async () =>
              createUser(ctx, user, identifiers, skipPasswordRequirement, () => {
                sent = true;
                record({ sourceId: user.userId, status: "creating" });
              }),
            {
              signal: ctx.stop,
              onRetry: ({ message, delaySeconds }) => {
                retries.push(message);
                ctx.schedule.pause(delaySeconds * 1000);
              },
            },
          );
    } catch (error) {
      // Unrecorded, so a re-run picks the user up like any other. A user whose
      // first create went out (a 429, a refused phone) has its `creating` line
      // to mark it unfinished, so it is not counted here as well.
      if (error instanceof NotSentError) {
        if (!sent) notSent++;
        return;
      }
      if (error instanceof RateLimitExceededError) {
        recordFailure(user.userId, error.message, "429", retries, false);
        return;
      }
      const apiError = error as BapiError;
      if (apiError.code === "user_quota_exceeded" && !ctx.quota.signal.aborted) {
        ctx.quota.abort();
        // Returned, not logged: a progress bar would redraw over a warning.
        stopReason = apiError.longMessage ?? apiError.message;
      }
      const unknown = outcomeUnknown(error);
      const message = apiError.longMessage ?? apiError.message ?? "Unknown error";
      recordFailure(
        user.userId,
        unknown ? `${message} (Clerk may have created the user; a re-run checks)` : message,
        String(apiError.status ?? "unknown"),
        retries,
        unknown,
      );
      return;
    }

    const line: UserLine = {
      sourceId: user.userId,
      clerkId: created.clerkUserId,
      status: "created",
      ...(user.passwordDropped ? { passwordDropped: true } : {}),
    };
    record(line);
    if (created.phoneRefusal) {
      const reason = normalizeErrorMessage(created.phoneRefusal);
      droppedPhones.set(reason, (droppedPhones.get(reason) ?? 0) + 1);
    }
    await finishUser(line, pendingIdentifiers(identifiers), [...created.notes, ...retries]);
    successful++;
    processed++;
    progress();
  };

  progress();
  await Promise.all([
    ...users.map(async (user) => processUser(user)),
    ...attachOnly.map(async (line) => finishUser(line, line.pending ?? [], [])),
  ]);

  return {
    totalProcessed: total,
    successful,
    failed,
    notSent,
    ...(stopReason ? { stopReason } : {}),
    droppedPhones,
    validationFailed,
    errorBreakdown,
  };
}
