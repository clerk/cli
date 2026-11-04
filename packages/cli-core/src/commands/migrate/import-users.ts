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
import { failureOf, normalizeErrorMessage, tallyError } from "./lib/failures.ts";
import { RateLimitExceededError, retryOn429 } from "./lib/retry.ts";
import type { PendingIdentifier, UserLine } from "./lib/run-store.ts";
import { RUN_MARKER_KEY } from "./lib/user-lookup.ts";
import { createApiScheduler, type ApiScheduler } from "./lib/scheduler.ts";
import type { ImportSummary, User } from "./types.ts";

// Re-exported for the tests and callers that grew up against this module.
export { readRetryAfter } from "./lib/retry.ts";

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
 * The values and parallel statuses for one identifier kind on `POST /v1/users`.
 *
 * A reserved identifier is unverified, but usable for sign-in and locked to
 * this user. Only the create can make one, so with `reserve` the unverified
 * identifiers go here instead of being attached afterwards.
 */
function createIdentifiers(
  verified: string | undefined,
  unverified: string[],
  reserve: boolean,
): { values: string[]; statuses?: string[] } {
  const values = [...(verified ? [verified] : []), ...(reserve ? unverified : [])];
  if (!reserve || unverified.length === 0) return { values };
  return {
    values,
    statuses: values.map((_, index) => (verified && index === 0 ? "verified" : "reserved")),
  };
}

/**
 * Builds the `POST /v1/users` request body.
 *
 * Optional fields are omitted rather than sent as null so Clerk applies its own
 * defaults for anything the source platform did not record.
 *
 * @param reserveUnverified - Create the identifiers the source never verified
 *   as reserved, in this request, rather than attaching them unverified.
 */
export function buildCreateUserBody(
  user: User,
  identifiers: Identifiers,
  skipPasswordRequirement: boolean,
  reserveUnverified = false,
): Record<string, unknown> {
  // The instance's allowlist, blocklist, disposable-email and subaddress rules
  // police sign-ups. These users already signed up, on the source platform.
  const body: Record<string, unknown> = { external_id: user.userId, skip_restriction_checks: true };

  const emails = createIdentifiers(
    identifiers.primaryEmail,
    identifiers.unverifiedEmails,
    reserveUnverified,
  );
  if (emails.values.length > 0) body.email_address = emails.values;
  if (emails.statuses) body.email_address_identification_status = emails.statuses;
  const phones = createIdentifiers(
    identifiers.primaryPhone,
    identifiers.unverifiedPhones,
    reserveUnverified,
  );
  if (phones.values.length > 0) body.phone_number = phones.values;
  if (phones.statuses) body.phone_number_identification_status = phones.statuses;
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
  /** Aborted by a run-store write that failed. Nothing goes out after it. */
  halt: AbortSignal;
  /** Aborted by a Ctrl-C, the quota or a halt. No create goes out after it. */
  stop: AbortSignal;
  /** Unverified identifiers go on the create as reserved, not attached after. */
  reserveUnverified: boolean;
};

/**
 * True when Clerk refused the create for a phone. The country error names no
 * parameter, only its own code. A phone another user holds also names
 * `phone_number`, and fails the user.
 */
function isPhoneRefusal(error: unknown): error is BapiError {
  return (
    error instanceof BapiError &&
    (error.code === "unsupported_country_code" ||
      (error.code === "form_param_format_invalid" && error.meta?.param_name === "phone_number"))
  );
}

/** True when the user Clerk returned already has this email or phone. */
function userHolds(user: unknown, kind: PendingIdentifier["kind"], value: string): boolean {
  const record = (user ?? {}) as {
    email_addresses?: { email_address?: string }[];
    phone_numbers?: { phone_number?: string }[];
  };
  if (kind === "email") {
    const wanted = value.trim().toLowerCase();
    return (record.email_addresses ?? []).some(
      (entry) => entry.email_address?.toLowerCase() === wanted,
    );
  }
  // Clerk stores phones in E.164; the source may carry spaces, dashes or parens.
  const digits = (phone: string) => phone.replace(/\D/g, "");
  return (record.phone_numbers ?? []).some(
    (entry) => digits(entry.phone_number ?? "") === digits(value),
  );
}

/** The message with the identifier it names replaced by `<email>` or `<phone>`. */
function withoutValue(message: string, value: string, kind: PendingIdentifier["kind"]): string {
  const escaped = RegExp.escape(value.trim());
  return escaped ? message.replace(new RegExp(escaped, "gi"), `<${kind}>`) : message;
}

/**
 * Starts the note on an attach left pending for a re-run, which tries it again:
 * a continue drops the earlier one rather than repeating it.
 */
const NOT_ADDED_YET = "Not added yet: ";

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

/**
 * The extra identifiers a user carries, in the order they are attached.
 *
 * @param reserveUnverified - The unverified ones went on the create as
 *   reserved, so there is nothing to attach for them.
 */
export function pendingIdentifiers(
  identifiers: Identifiers,
  reserveUnverified = false,
): PendingIdentifier[] {
  if (reserveUnverified) {
    identifiers = { ...identifiers, unverifiedEmails: [], unverifiedPhones: [] };
  }
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
 * @returns A note and the `refused` reason when Clerk refused the identifier.
 *   `pending` when nothing says whether it attached, or when the error is
 *   about the key or the rate limit, not the identifier: then with a note
 *   saying why, when Clerk gave one. Never throws: the user itself was already
 *   created.
 */
async function attachIdentifier(
  ctx: CreateContext,
  clerkUserId: string,
  { kind, value, verified }: PendingIdentifier,
): Promise<{ note?: string; refused?: string; pending?: boolean }> {
  const path = kind === "email" ? "/v1/email_addresses" : "/v1/phone_numbers";
  const body =
    kind === "email"
      ? { user_id: clerkUserId, email_address: value, primary: false, verified }
      : { user_id: clerkUserId, phone_number: value, primary: false, verified };

  // A Ctrl-C or a halt ends the wait for a slot or a backoff, and the attach is
  // left pending for a re-run. The quota does not: the user exists already.
  const stop = AbortSignal.any([interruptSignal(), ctx.halt]);
  const send = async (method: "GET" | "POST", requestPath: string, requestBody?: string) =>
    retryOn429(
      async () =>
        ctx.schedule(
          async () => {
            if (stop.aborted) throw new NotSentError();
            return bapiRequest({
              method,
              path: requestPath,
              secretKey: ctx.secretKey,
              body: requestBody,
            });
          },
          { first: true, stop },
        ),
      { signal: stop, onRetry: ({ delaySeconds }) => ctx.schedule.pause(delaySeconds * 1000) },
    );
  try {
    await send("POST", path, JSON.stringify(body));
    return {};
  } catch (error) {
    if (error instanceof NotSentError || outcomeUnknown(error)) return { pending: true };
    // Taken may mean taken by this user: an earlier attach with no answer, or
    // one a stopped run never wrote down, landed. Its retry is no refusal.
    if (error instanceof BapiError && error.code === "form_identifier_exists") {
      try {
        const held = await send("GET", `/v1/users/${encodeURIComponent(clerkUserId)}`);
        if (userHolds(held.body, kind, value)) return {};
      } catch {
        // No answer to say it attached: a re-run tries again.
        return { pending: true };
      }
    }
    // A key Clerk stopped accepting or doesn't permit, or a 429 that outlasted
    // the retries, says nothing about the email or phone: left pending, a
    // re-run attaches it. A country Clerk doesn't support, or an email the
    // instance's allowlist or blocklist refuses, is about the identifier.
    const aboutTheKey =
      error instanceof BapiError &&
      (error.status === 401 ||
        (error.status === 403 &&
          error.code !== "unsupported_country_code" &&
          error.code !== "not_allowed_access"));
    const kindLabel = `${verified ? "additional" : "unverified"} ${kind}`;
    const { message } = failureOf(error);
    if (!(error instanceof BapiError) || aboutTheKey) {
      return { pending: true, note: `${NOT_ADDED_YET}${kindLabel} ${value}: ${message}` };
    }
    return {
      note: `Failed to add ${kindLabel} ${value}: ${message}`,
      // Without the value, so users refused for one reason group as one.
      refused: `${kindLabel}: ${normalizeErrorMessage(withoutValue(message, value, kind))}`,
    };
  }
}

/**
 * Attaches each identifier. Extra identifiers are best-effort: a duplicate
 * secondary email should not undo a user who was otherwise imported.
 *
 * @returns A note per identifier Clerk refused or left pending with a reason,
 *   why by kind for those refused, and those still pending.
 */
async function attachAll(
  ctx: CreateContext,
  clerkUserId: string,
  identifiers: PendingIdentifier[],
): Promise<{ notes: string[]; refused: string[]; pending: PendingIdentifier[] }> {
  const results = await Promise.all(
    identifiers.map(async (identifier) => attachIdentifier(ctx, clerkUserId, identifier)),
  );
  return {
    notes: results.flatMap((result) => (result.note ? [result.note] : [])),
    refused: results.flatMap((result) => (result.refused ? [result.refused] : [])),
    pending: identifiers.filter((_, index) => results[index]?.pending),
  };
}

/** What a create retried without a refused phone leaves out for good. */
type PhoneRetry = {
  /** The phones the user is imported without. */
  lost: string[];
  /** Clerk's reason, when any phone is lost. */
  reason: string | undefined;
};

type CreatedUser = {
  clerkUserId: string;
  notes: string[];
  /** Reserved phones a refusal kept off the create, to attach one by one. */
  attachLater?: string[];
  phoneRefusal?: string;
};

/**
 * Creates one user, retrying without a phone Clerk refuses.
 *
 * @param sending - Called as each `POST /v1/users` goes out, so the run
 *   records the user only once a create may actually land.
 * @returns The Clerk ID, a note when the phone was dropped, Clerk's reason
 *   for refusing it, and the reserved phones still to attach.
 */
async function createUser(
  ctx: CreateContext,
  user: User,
  identifiers: Identifiers,
  skipPasswordRequirement: boolean,
  /**
   * Called as each attempt goes out, with what it sends and, on a retry
   * without the phone, the phones the user would be imported without and
   * Clerk's reason.
   */
  sending: (body: Record<string, unknown>, retry?: PhoneRetry) => void,
): Promise<CreatedUser> {
  // A Ctrl-C or a full instance hands the slot on to queued creates; none
  // of them is sent, and none waits for a paced turn to find that out.
  const create = async (body: Record<string, unknown>, retry?: PhoneRetry) =>
    ctx.schedule(
      async () => {
        if (ctx.stop.aborted) throw new NotSentError();
        sending(body, retry);
        return bapiRequest({
          method: "POST",
          path: "/v1/users",
          secretKey: ctx.secretKey,
          body: JSON.stringify(body),
        });
      },
      { stop: ctx.stop },
    );

  const body = buildCreateUserBody(
    user,
    identifiers,
    skipPasswordRequirement,
    ctx.reserveUnverified,
  );
  // The run's marker, with whatever private metadata the source brought:
  // without it a create cut off mid-flight could never be told from a user
  // someone else made with the same external_id. It replaces a marker the
  // source carries, from a run that imported the user there.
  if (ctx.runId) {
    body.private_metadata = {
      ...(body.private_metadata as Record<string, unknown> | undefined),
      [RUN_MARKER_KEY]: ctx.runId,
    };
  }
  const notes: string[] = [];
  let phoneRefusal: string | undefined;
  let attachLater: string[] = [];
  let response;
  try {
    response = await create(body);
  } catch (error) {
    // A phone Clerk refuses (a country it does not support, a number that is
    // not E.164) should not cost a user who has an email to be created under.
    if (!isPhoneRefusal(error)) throw error;
    const {
      phone_number: sent,
      phone_number_identification_status: statuses,
      ...withoutPhone
    } = body;
    let refusal = error;
    let dropped = sent as string[];
    // Which reserved phone was refused is unknown when there are several, or
    // when the verified one was refused alone: each is attached on its own once
    // the user exists, unverified, so only a refused one is lost. Worked out
    // before each retry too, so its line says what a create cut off would lose.
    const settle = (left: string[], why: BapiError): PhoneRetry & { later: string[] } => {
      const reservedLeft = left.filter((phone) => phone !== identifiers.primaryPhone);
      const later = statuses && (why !== error || reservedLeft.length > 1) ? reservedLeft : [];
      const lost = left.filter((phone) => !later.includes(phone));
      return {
        later,
        lost,
        reason: lost.length > 0 ? (why.longMessage ?? why.message) : undefined,
      };
    };
    // With reserved phones on the create, any one of them may be the refused
    // one: the verified phone alone goes first, so it is not lost with them.
    if (statuses && identifiers.primaryPhone) {
      const withPrimary = dropped.filter((phone) => phone !== identifiers.primaryPhone);
      try {
        response = await create(
          { ...withoutPhone, phone_number: [identifiers.primaryPhone] },
          settle(withPrimary, error),
        );
        dropped = withPrimary;
      } catch (retryError) {
        if (!isPhoneRefusal(retryError)) throw retryError;
        refusal = retryError;
      }
    }
    if (!response) {
      if (!body.email_address) throw refusal;
      response = await create(withoutPhone, settle(dropped, refusal));
    }
    const settled = settle(dropped, refusal);
    attachLater = settled.later;
    if (settled.reason) {
      phoneRefusal = settled.reason;
      notes.push(`Failed to add phone ${settled.lost.join(", ")}: ${phoneRefusal}`);
    }
  }

  // Untracked, the user could never be undone. Thrown, the outcome is unknown,
  // so `creating` stays the latest line and a re-run looks the user up.
  const clerkUserId = (response.body as { id?: unknown })?.id;
  if (typeof clerkUserId !== "string" || !clerkUserId) {
    throw new Error("Clerk answered POST /v1/users without a user ID");
  }
  return {
    clerkUserId,
    notes,
    attachLater,
    ...(phoneRefusal ? { phoneRefusal } : {}),
  };
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
  /**
   * Source ID → the `creating` line of each adopted user's create, which says
   * how it was made: `reserved` when it reserved the unverified identifiers
   * (the rest had them attached unverified, whatever this run's
   * `reserveUnverified` says), `pending` for reserved phones a retry after a
   * refused phone left out (attached once the user is adopted, unverified, as
   * they would have been), and `phoneRefused` when the create that landed was
   * the retry without the first phone.
   */
  adoptedLines?: Map<string, UserLine>;
  /** Allow users that carry no password. */
  skipPasswordRequirement?: boolean;
  /** Create the identifiers the source never verified as reserved. */
  reserveUnverified?: boolean;
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
    record: recordLine,
    attachOnly = [],
    runId,
    adopted = new Map<string, string>(),
    adoptedLines = new Map<string, UserLine>(),
    skipPasswordRequirement = true,
    reserveUnverified = false,
    validationFailed = 0,
    progress: report,
  } = options;

  const total = users.length;
  const errorBreakdown = new Map<string, number>();
  let processed = 0;
  let successful = 0;
  let failed = 0;
  let unconfirmed = 0;
  let notSent = 0;
  let stopReason: string | undefined;
  const droppedPhones = new Map<string, number>();
  const droppedIdentifiers = new Map<string, number>();

  // A line that cannot be written halts the import: a user created with no
  // record is beyond both `undo` and a re-run. The error is rethrown once
  // every user has settled, so no request goes out after the import rejects.
  const halt = new AbortController();
  let storeFailure: { error: unknown } | undefined;
  const record = (line: UserLine) => {
    try {
      recordLine(line);
    } catch (error) {
      storeFailure ??= { error };
      halt.abort();
      throw error;
    }
  };

  const quota = new AbortController();
  const ctx: CreateContext = {
    secretKey,
    schedule: createApiScheduler(limits.concurrencyLimit, limits.rateLimit),
    quota,
    halt: halt.signal,
    stop: AbortSignal.any([interruptSignal(), quota.signal, halt.signal]),
    reserveUnverified,
    runId,
  };

  // Attach-only users count towards the bar too: a continue with only those
  // left would otherwise sit at 0/0.
  let attachedUsers = 0;
  const progress = () => report?.({ done: processed + attachedUsers, ok: successful, failed });

  const recordFailure = (
    userId: string,
    message: string,
    code: string,
    notes: string[],
    unknown: boolean,
    attempt?: UserLine,
  ) => {
    if (unknown) unconfirmed++;
    else failed++;
    processed++;
    tallyError(errorBreakdown, message);
    // With no answer, the user stays `creating`: Clerk may hold it, and a
    // re-run looks it up before creating it again. The line still says why,
    // and keeps what the attempt reserved and left out: a continue reads only
    // the latest line to adopt the user the way it was created.
    record({
      sourceId: userId,
      status: unknown ? "creating" : "failed",
      ...(unknown && attempt?.reserved ? { reserved: true } : {}),
      ...(unknown && attempt?.pending ? { pending: attempt.pending } : {}),
      ...(unknown && attempt?.phoneRefused ? { phoneRefused: attempt.phoneRefused } : {}),
      error: [message, ...notes].join("; "),
      code,
    });
    progress();
  };

  /**
   * Attaches a created user's extra identifiers. The user is already on record
   * with them `pending`, so a run stopped before they attach can finish them.
   */
  const finishUser = async (line: UserLine, toAttach: PendingIdentifier[], notes: string[]) => {
    const { error: _error, pending: _pending, refused: earlier = [], ...base } = line;
    const attached = await attachAll(ctx, base.clerkId ?? "", toAttach);
    const error = [...notes, ...attached.notes].join("; ");
    // Imported, but without what Clerk refused: a warning for the summary,
    // counted once per user and reason. A continue keeps the earlier ones.
    for (const reason of new Set(attached.refused)) {
      droppedIdentifiers.set(reason, (droppedIdentifiers.get(reason) ?? 0) + 1);
    }
    const refused = [...new Set([...earlier, ...attached.refused])];
    // A second line, which wins as the latest, adds what happened on the way.
    // With nothing to attach, the first line already says it all.
    if (toAttach.length > 0) {
      record({
        ...base,
        ...(error ? { error } : {}),
        ...(refused.length > 0 ? { refused } : {}),
        ...(attached.pending.length > 0 ? { pending: attached.pending } : {}),
      });
    }
  };

  /**
   * A user a stopped run's create made: only its extras are left. When that
   * create was the retry without a refused phone, the phone is still lost.
   */
  const adoptedUser = (clerkUserId: string, sourceId: string): CreatedUser => {
    const creating = adoptedLines.get(sourceId);
    const phoneRefusal = creating?.phoneRefused;
    return {
      clerkUserId,
      notes: phoneRefusal ? [`Failed to add phone: ${phoneRefusal}`] : [],
      attachLater: (creating?.pending ?? [])
        .filter((entry) => entry.kind === "phone")
        .map((entry) => entry.value),
      ...(phoneRefusal ? { phoneRefusal } : {}),
    };
  };

  const processUser = async (user: User): Promise<void> => {
    const retries: string[] = [];
    const identifiers = splitIdentifiers(user);
    let created: CreatedUser;
    const adoptedId = adopted.get(user.userId);
    // What the create did with the unverified identifiers decides what is left
    // to attach: an adopted user's create may have run in the other mode.
    const reserved = adoptedId
      ? adoptedLines.get(user.userId)?.reserved === true
      : reserveUnverified &&
        (identifiers.unverifiedEmails.length > 0 || identifiers.unverifiedPhones.length > 0);
    let sent = false;
    // The `creating` line of the latest attempt, for an unknown outcome to keep.
    let attempt: UserLine | undefined;
    try {
      created = adoptedId
        ? adoptedUser(adoptedId, user.userId)
        : await retryOn429(
            async () =>
              createUser(ctx, user, identifiers, skipPasswordRequirement, (body, retry) => {
                // A retry after a refused phone sends without the reserved
                // ones. Cut off before its answer, the user would be adopted
                // as reserved, those phones never attached. One the retry
                // already counts as lost would only be refused again.
                const sentPhones = new Set((body.phone_number as string[] | undefined) ?? []);
                const leftOut = reserved
                  ? identifiers.unverifiedPhones.filter(
                      (phone) => !sentPhones.has(phone) && !retry?.lost.includes(phone),
                    )
                  : [];
                attempt = {
                  sourceId: user.userId,
                  status: "creating",
                  ...(reserved ? { reserved: true } : {}),
                  ...(retry?.reason ? { phoneRefused: normalizeErrorMessage(retry.reason) } : {}),
                  ...(leftOut.length > 0
                    ? {
                        pending: leftOut.map((value) => ({
                          kind: "phone" as const,
                          value,
                          verified: false,
                        })),
                      }
                    : {}),
                };
                record(attempt);
                sent = true;
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
      // Not an API outcome: the request never went out.
      if (storeFailure && error === storeFailure.error) throw error;
      // Unrecorded, so a re-run picks the user up like any other.
      if (error instanceof NotSentError && !sent) {
        notSent++;
        return;
      }
      // Only a definite refusal (a 429, a refused phone) is retried, so a stop
      // after a create went out leaves a user Clerk does not hold.
      if (error instanceof NotSentError) {
        recordFailure(
          user.userId,
          "Stopped before the user was created",
          "stopped",
          retries,
          false,
        );
        return;
      }
      const apiError = error as BapiError;
      if (apiError.code === "user_quota_exceeded" && !ctx.quota.signal.aborted) {
        ctx.quota.abort();
        // Returned, not logged: a progress bar would redraw over a warning.
        stopReason = apiError.longMessage ?? apiError.message;
      }
      const unknown = outcomeUnknown(error);
      const { message, code } = failureOf(error);
      recordFailure(
        user.userId,
        unknown ? `${message} (Clerk may have created the user; a re-run checks)` : message,
        code,
        retries,
        unknown,
        attempt,
      );
      return;
    }

    const phoneRefused = created.phoneRefusal && normalizeErrorMessage(created.phoneRefusal);
    const line: UserLine = {
      sourceId: user.userId,
      clerkId: created.clerkUserId,
      status: "created",
      ...(user.passwordDropped ? { passwordDropped: true } : {}),
      ...(phoneRefused ? { phoneRefused } : {}),
    };
    // One line, pending and all: a run stopped between a `created` line and a
    // later `pending` one would read the user as settled, its extras unsent.
    const retried = (created.attachLater ?? []).map((value) => ({
      kind: "phone" as const,
      value,
      verified: false,
    }));
    const toAttach = [...pendingIdentifiers(identifiers, reserved), ...retried];
    // Its notes too: a run stopped before the next line would lose them.
    const notes = [...created.notes, ...retries];
    const firstNotes = notes.join("; ");
    record({
      ...line,
      ...(firstNotes ? { error: firstNotes } : {}),
      ...(toAttach.length > 0 ? { pending: toAttach } : {}),
    });
    if (phoneRefused) droppedPhones.set(phoneRefused, (droppedPhones.get(phoneRefused) ?? 0) + 1);
    await finishUser(line, toAttach, notes);
    successful++;
    processed++;
    progress();
  };

  progress();
  const attachOnlyUser = async (line: UserLine) => {
    // Its earlier error names identifiers Clerk refused; the new line keeps it.
    // The pending ones are tried again, and noted again if still pending.
    const earlier = (line.error ?? "")
      .split("; ")
      .filter((note) => note && !note.startsWith(NOT_ADDED_YET));
    await finishUser(line, line.pending ?? [], earlier);
    // Created by this run's earlier attempt, as an adopted user was: the bar,
    // the summary and `result.created` all count it.
    successful++;
    attachedUsers++;
    progress();
  };
  // A halt leaves its error to be rethrown below, once every user has settled.
  const settle = async (work: Promise<void>) =>
    work.catch((error: unknown) => {
      if (!storeFailure) throw error;
    });
  await Promise.all([
    ...users.map(async (user) => settle(processUser(user))),
    ...attachOnly.map(async (line) => settle(attachOnlyUser(line))),
  ]);
  if (storeFailure) throw storeFailure.error;

  return {
    totalProcessed: total,
    successful,
    failed,
    unconfirmed,
    notSent,
    ...(stopReason ? { stopReason } : {}),
    droppedPhones,
    droppedIdentifiers,
    validationFailed,
    errorBreakdown,
  };
}
